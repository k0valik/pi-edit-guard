/**
 * Edit tool override — the Edit Guard's single prompt surface.
 *
 * Registered under the built-in name `edit` (extension tools win over
 * built-ins by name). The model calls `edit` exactly as it always has; behind
 * that name it gets the full pipeline: argument repair (prepareArguments),
 * multi-pass fuzzy chain + anchor window + auto-expand (executor), stale-read
 * protection and path preflight (hooks), and loop-breaking (stormbreaker).
 *
 * Native parity kept where the UI/session depends on it:
 *   - schema descriptions verbatim (models are trained on them) + `anchor`
 *   - `description` / `promptSnippet` / `promptGuidelines` mirror native + anchor
 *   - success text "Successfully replaced N block(s) in path."
 *   - `details = { diff, patch, firstChangedLine }` via pi's own diff helpers
 *   - failures THROW (native convention) — with strictly richer content
 *     (closest candidate, near-miss previews, line positions)
 *   - abort checks between stages (native throwIfAborted parity)
 *   - `withFileMutationQueue` on the RESOLVED path (parallel-write safety)
 *   - stale-read registry injected via registerEditTool(pi, { registry }) —
 *     the executor self-refreshes after a successful write so read→edit→edit
 *     never self-blocks (no globalThis bridge).
 *
 * `renderCall`/`renderResult` are omitted on purpose: the built-in edit
 * renderer is inherited per slot.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  generateDiffString,
  generateUnifiedPatch,
  withFileMutationQueue,
  type EditToolDetails,
} from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import {
  executeFile,
  formatAlternatives,
  formatAmbiguousReason,
} from "../../edit/pipeline/execute.js";
import { resolveToCwd } from "../../shared/paths.js";
import { saveUndo } from "../../history/store.js";
import {
  EDIT_SCHEMA,
  prepareEditArguments,
  repairLifecycle,
  type EditInput,
} from "../../repair/entry.js";
import { getConfig } from "../../config/settings.js";
import type { EditDiagnostic } from "../../edit/model.js";
import { getOutsideCwdAdvisory } from "../../guards/workspace/advisory.js";
import { formatRepairNotes } from "../../repair/lifecycle.js";
import { telemetry } from "../../telemetry.js";

/** Native `details` shape (UI/session contract) plus the additive guard block. */
export interface EditGuardToolDetails extends EditToolDetails {
  guard: {
    passNames: string[];
    repaired: string[];
    diagnostics: EditDiagnostic[];
    anchorUsed: boolean;
    durationMs: number;
    coherenceWarnings: string[];
    corruptionWarnings: string[];
    postWriteWarnings: string[];
    /** Semantic-placement advisories (token_overlap matches). */
    semanticWarnings: string[];
    isPartial?: boolean;
    appliedCount?: number;
    failedCount?: number;
  };
}

// Native validateEditInput parity: the schema allows an empty edits array, so
// the tool rejects it explicitly with the same message native uses.
function validateEditInput(input: EditInput): void {
  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
  }
}

export interface EditToolOptions {
  /** Stale-read registry for post-write self-refresh (from the hook). */
  registry?: {
    selfRefresh(path: string): void;
    getStaleWarning(path: string): string | null;
  };
}

export function registerEditTool(pi: ExtensionAPI, options: EditToolOptions = {}): void {
  const cfg = getConfig();

  // Killswitch: when disabled, native edit remains untouched.
  if (!cfg.editOverrideEnabled) return;

  pi.registerTool({
    name: "edit",
    label: "edit",
    description:
      'Edit a single file using exact text replacement. "edits" is always an array of edit objects, even for a single edit. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes. If the text to replace appears more than once, include an anchor string from nearby unique text to restrict the search to that region.',
    promptSnippet:
      "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
    promptGuidelines: [
      "Use edit for precise changes (edits[].oldText must match exactly)",
      "When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
      "Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
      "Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
      "If edits[].oldText appears in more than one place, add an anchor: text copied verbatim from the file immediately above or below the lines being replaced — a heading, comment, or distinctive line. The anchor identifies which copy to change, so oldText can stay short and exact.",
      "For renames where the same text appears in multiple places, set replaceAll: true to replace every occurrence in the file.",
    ],
    parameters: EDIT_SCHEMA,
    prepareArguments: (args) => prepareEditArguments(args) as Static<typeof EDIT_SCHEMA>,
    async execute(
      toolCallId: string,
      params: EditInput,
      signal: AbortSignal | undefined,
      _onUpdate,
      ctx: ExtensionContext,
    ) {
      // Do not reject from an abort event listener: that would release the
      // mutation queue while an in-flight fs operation may still finish.
      // Checking signal.aborted after each await observes the same aborts
      // while keeping the queue locked (native throwIfAborted parity).
      const throwIfAborted = () => {
        if (signal?.aborted) throw new Error("Operation aborted");
      };
      throwIfAborted();

      validateEditInput(params);

      // Pull repair notes produced by prepareArguments (keyed on the
      // serialized repaired args; a miss just means no notes — never wrong).
      const feedback = repairLifecycle.correlate("edit", params, toolCallId);

      const { path, edits } = params;
      const resolvedPath = resolveToCwd(path, ctx.cwd);

      const advisory = await getOutsideCwdAdvisory(ctx, {
        toolName: "edit",
        absolutePath: resolvedPath,
      });

      // Start envelope tracking. One envelope per edit CALL (not per edits[]
      // item) — the index field is reserved for future per-item tracking and
      // is currently a constant 0. The token keys this call's context, so an
      // overlapping call can never mis-attribute or clear it.
      const telemetryToken = telemetry.beginEdit(path, 0);

      let envelopeData:
        | {
            passNames: string[];
            editsApplied: number;
            anchorUsed: boolean;
            corruptionWarnings: string[];
            coherenceWarnings: string[];
            postWriteWarnings: string[];
            semanticWarnings?: string[];
            closestCandidate?: { similarity: number; lineRange?: { start: number; end: number } };
            isPartial: boolean;
            appliedCount?: number;
            failedCount?: number;
            repairNotes?: string[];
          }
        | undefined;

      try {
        return await withFileMutationQueue(resolvedPath, async () => {
          throwIfAborted();

          // Sample staleness BEFORE execution: a successful write refreshes
          // the registry (self-heal), so asking afterwards would miss real
          // drift and only ever see our own write noise (mined 2026-08-18,
          // commit.md advisory-on-clean-edit). Raw path — the same key the
          // tool_call hook recorded.
          const staleWarning = options.registry?.getStaleWarning?.(path);

          const result = await executeFile(path, edits, {
            cwd: ctx.cwd,
            selfRefresh: options.registry?.selfRefresh,
            coherenceCheckEnabled: getConfig().coherenceCheckEnabled,
          });

          // Capture envelope data for both success and error paths
          const diag = (result.details as { diagnostics?: EditDiagnostic[] })?.diagnostics ?? [];
          const anchorUsed = diag.some((d) => d.match?.anchorUsed === true);
          envelopeData = {
            passNames: [...new Set((result.details as { passNames?: string[] })?.passNames ?? [])],
            editsApplied:
              (result.details as { appliedCount?: number })?.appliedCount ??
              (result.isError ? 0 : edits.length),
            anchorUsed,
            corruptionWarnings:
              (result.details as { corruptionWarnings?: string[] })?.corruptionWarnings ?? [],
            coherenceWarnings:
              (result.details as { coherenceWarnings?: string[] })?.coherenceWarnings ?? [],
            postWriteWarnings:
              (result.details as { postWriteWarnings?: string[] })?.postWriteWarnings ?? [],
            semanticWarnings:
              (result.details as { semanticWarnings?: string[] })?.semanticWarnings ?? [],
            closestCandidate: (
              result.details as {
                closestCandidate?: {
                  similarity: number;
                  lineRange?: { start: number; end: number };
                };
              }
            ).closestCandidate,
            isPartial: (result.details as { isPartial?: boolean })?.isPartial ?? false,
            appliedCount: (result.details as { appliedCount?: number })?.appliedCount,
            failedCount: (result.details as { failedCount?: number })?.failedCount,
            repairNotes: feedback?.notes ?? [],
          };

          if (result.isError) {
            // Emit envelope for failed edits (captures closest candidates, etc.)
            // Through the recorder: GuardStats counters + ring buffer + the
            // pending batch (written at the next lifecycle checkpoint).
            const envelope = telemetry.endEdit({ token: telemetryToken, ...envelopeData });
            if (envelope) {
              telemetry.record(envelope);
            }

            // Native throw convention — the content already carries the enriched
            // message (closest candidate, near-miss previews, line positions).
            const text = result.content
              .filter((c) => c.type === "text")
              .map((c) => c.text ?? "")
              .join("\n");
            const notes = formatRepairNotes(feedback?.notes ?? []);
            repairLifecycle.take(toolCallId);
            throw new Error([text, notes, advisory].filter(Boolean).join("\n") || "Edit failed.");
          }

          // Consume repair lifecycle state on success so it doesn't leak
          // into subsequent edits or persist until session shutdown.
          repairLifecycle.take(toolCallId);

          const isPartial = (result.details as { isPartial?: boolean }).isPartial === true;

          // Native details shape: diff/patch/firstChangedLine over the
          // LF-normalized pre/post content (same inputs native uses).
          const {
            baseContent,
            newContent,
            bom,
            originalEnding,
            coherenceWarnings,
            corruptionWarnings,
            postWriteWarnings,
            semanticWarnings,
          } = result.details as {
            baseContent: string;
            newContent: string;
            bom: string;
            originalEnding: "\n" | "\r\n";
            coherenceWarnings: string[];
            corruptionWarnings?: string[];
            postWriteWarnings?: string[];
            semanticWarnings?: string[];
          };

          // Capture undo before returning — only when the edit actually changed
          // something. Noop edits waste undo slots.
          if (getConfig().undoEnabled && baseContent !== newContent) {
            const detailsAny = result.details as Record<string, unknown> | undefined;
            const undo = await saveUndo(
              resolvedPath,
              {
                content: baseContent,
                bom: bom ?? "",
                originalEnding: originalEnding ?? "\n",
                resultContent: newContent,
                rawContent: detailsAny?.rawContent as string | undefined,
                rawResult: detailsAny?.rawResult as string | undefined,
                encoding: detailsAny?.encoding as "utf-8" | "latin1",
                sessionId: ctx.sessionManager.getSessionId(),
                project: ctx.cwd,
              },
              undefined,
              { maxBytes: getConfig().undoMaxBytes },
            );

            if (!undo.persisted) {
              throw new Error(
                `[E_UNDO_UNAVAILABLE] Cannot persist undo history for ${path}. The edit was applied, but undo is unavailable. Retry, or disable undo if the store cannot be recovered.`,
              );
            }
          }

          throwIfAborted();

          const diffResult = generateDiffString(baseContent, newContent);
          const patch = generateUnifiedPatch(path, baseContent, newContent);

          // Coherence warnings are computed inside the executor (the final
          // pipeline step). Surfaced in result text, details.guard, and the
          // edit.applied telemetry event below.

          const passNames = [...new Set(result.details?.passNames as string[])];
          const diagnostics = (result.details?.diagnostics as EditDiagnostic[] | undefined) ?? [];

          const detailsAny = result.details as Record<string, unknown> | undefined;
          const partialAppliedCount = (detailsAny?.appliedCount as number | undefined) ?? 0;
          const partialEditsApplied = (detailsAny?.editsApplied as number[] | undefined) ?? [];
          const partialDiagnostics =
            (detailsAny?.diagnostics as EditDiagnostic[] | undefined) ?? [];

          const partialLines: string[] = [
            `[PARTIAL APPLY] Applied ${partialAppliedCount} of ${edits.length} edits in ${path}.`,
          ];
          const failedDiagnostics = partialDiagnostics.filter((d) => d.status !== "applied");
          if (failedDiagnostics.length > 0) {
            partialLines.push("Failures:");
            for (const diag of failedDiagnostics) {
              const reason = formatAmbiguousReason(diag, path);
              partialLines.push(`  edits[${diag.index}]: ${diag.status} (${reason})`);
              // Surface compact alternatives for ambiguous failures so the
              // model can disambiguate without re-querying.
              if (
                diag.status === "ambiguous" &&
                diag.alternatives &&
                diag.alternatives.length > 0
              ) {
                const formatted = formatAlternatives(diag.alternatives, 2, 4);
                if (formatted) {
                  partialLines.push(formatted.trim());
                }
              }
            }
          }
          if (partialEditsApplied.length > 0) {
            // Index LIST, not a count: bare "Applied edits: 0" collided with
            // the "Applied N of M" header and read as zero-applied (mined
            // pr-stack-session 2026-08-25). edits[N] vocabulary matches the
            // Failures lines so models see one consistent addressing scheme.
            partialLines.push(
              `Applied edit indices: ${partialEditsApplied.map((i) => `edits[${i}]`).join(", ")}`,
            );
          }

          const parts: string[] = [
            isPartial
              ? partialLines.join("\n")
              : `Successfully replaced ${edits.length} block(s) in ${path}.`,
          ];
          const noteBlock = formatRepairNotes(feedback?.notes ?? []);
          if (noteBlock) {
            parts.push(noteBlock);
          }
          if (!isPartial) {
            parts.push(`Applied: ${edits.length} | Failed: 0 | Skipped: 0`);
          }
          const warnings: string[] = [];
          for (const warning of coherenceWarnings) {
            const stripped = warning.replace(/^Warning:\s*/, "");
            const lineMatch = stripped.match(/^Line (\d+) has (.*)\.$/);
            if (lineMatch) {
              warnings.push(`- Line ${lineMatch[1]}: ${lineMatch[2]}`);
            } else {
              warnings.push(`- ${stripped.replace(/\.$/, "")}`);
            }
          }
          for (const warning of corruptionWarnings ?? []) {
            warnings.push(`- ${warning.replace(/\.$/, "")}`);
          }
          for (const warning of postWriteWarnings ?? []) {
            warnings.push(`- ${warning.replace(/\.$/, "")}`);
          }
          for (const warning of semanticWarnings ?? []) {
            warnings.push(`- ${warning.replace(/\.$/, "")}`);
          }
          if (staleWarning) {
            warnings.push(`- ${staleWarning}`);
          }
          for (const diag of diagnostics) {
            if (diag.status === "noop") {
              const reason = diag.reason ?? "edit did nothing";
              warnings.push(`- edits[${diag.index}]: noop (${reason})`);
            }
          }
          for (const diag of failedDiagnostics) {
            const reason = formatAmbiguousReason(diag, path);
            warnings.push(`- edits[${diag.index}]: ${diag.status} (${reason})`);
          }
          if (isPartial) {
            warnings.push(
              `[PARTIAL APPLY] Applied ${partialAppliedCount} of ${edits.length} edits in ${path}.`,
            );
            if (partialEditsApplied.length > 0) {
              warnings.push(
                `Applied edit indices: ${partialEditsApplied.map((i) => `edits[${i}]`).join(", ")}`,
              );
            }
          }
          if (warnings.length > 0) {
            parts.push("[WARNINGS]");
            parts.push(...warnings);
            if (getConfig().warningsEnabled) {
              try {
                ctx.ui.notify(`Edit warnings for ${path}:\n${warnings.join("\n")}`, "warning");
              } catch {
                // notify is best-effort; never break tool execution from UI surfacing
              }
            }
          }

          if (advisory) {
            parts.push(advisory);
          }

          // Emit envelope for successful edits (before return)
          const envelope = telemetry.endEdit({ token: telemetryToken, ...envelopeData });
          if (envelope) {
            telemetry.record(envelope);
          }

          return {
            content: [{ type: "text", text: parts.join("\n") }],
            details: {
              diff: diffResult.diff,
              patch,
              firstChangedLine: diffResult.firstChangedLine,
              guard: {
                passNames,
                repaired: feedback?.notes ?? [],
                diagnostics,
                anchorUsed,
                durationMs: (result.details?.durationMs as number | undefined) ?? 0,
                coherenceWarnings,
                corruptionWarnings: corruptionWarnings ?? [],
                postWriteWarnings: postWriteWarnings ?? [],
                semanticWarnings: semanticWarnings ?? [],
                isPartial,
                appliedCount: (result.details as { appliedCount?: number }).appliedCount,
                failedCount: (result.details as { failedCount?: number }).failedCount,
              },
            } satisfies EditGuardToolDetails,
          };
        });
      } finally {
        // Emit the envelope on abort — ensures the audit trail never loses
        // an edit call's telemetry even when stormbreaker breaks the loop.
        if (envelopeData) {
          const envelope = telemetry.endEdit({ token: telemetryToken, ...envelopeData });
          if (envelope) {
            telemetry.record(envelope);
          }
        } else {
          // Aborted before execution produced data (e.g. mid-queue cancel):
          // endEdit never ran, so drop THIS call's context explicitly or
          // it lingers until the session ends (keyed by token — a concurrent
          // call's context is untouched).
          telemetry.clearEditContext(telemetryToken);
        }
      }
    },
  });
}
