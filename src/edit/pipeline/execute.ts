/**
 * Per-file executor — the full edit pipeline for one file.
 *
 * Flow: read raw bytes → detect encoding/BOM/line-ending → LF-normalize →
 * autopatch (fix common oldText mistakes) → resolve (anchor + fuzzy chain
 * + uniqueness, two-pass incremental fallback) → apply (bottom-up splices)
 * → raw-splice back onto original bytes → atomic write (tmp + rename) →
 * coherence/corruption/semantic advisories → undo snapshot → diff/patch for
 * the tool layer. Partial-apply (some edits succeed, some fail) writes the
 * successful subset and reports both applied/failed sets. Post-write re-read
 * verifies bytes on disk; stale-read self-refresh and withFileMutationQueue
 * integration live here as well.
 *
 * Provenance / shape rationale (do not re-introduce the old bugs):
 * - Extracted from the old patch tool (tools/patch-tool.ts). Path is resolved
 *   against `cwd` via resolveToCwd — the old code resolved relative paths
 *   against process.cwd() implicitly, breaking multi-project sessions.
 * - Tmp-file cleanup on write failure UNLINKS the temp file (not truncates);
 *   the old truncating path littered `.patch-tool-*.tmp` files in target dirs.
 * - The entire read→write cycle is wrapped in an optional `mutationQueue`
 *   (pi's withFileMutationQueue, keyed on the *resolved* path, matching native
 *   edit) so concurrent edits to the same file serialize. Do not move the
 *   queue boundary inward.
 * - Post-write re-read runs unconditionally — the tool layer already holds the
 *   mutation queue around executeFile, so the re-read cannot interleave with a
 *   sibling write. Making it conditional re-opens the interleaving window.
 * - Pure core aside from injected fs/queue/selfRefresh callbacks, so the
 *   module stays unit-testable in isolation (see __tests__/execute-file.test.ts).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { applyEdits } from "./apply.js";
import { buildPassSplices, failureToError, resolveBlocks } from "./resolve.js";
import { coherenceCheck } from "../../advisories/coherence.js";
import { autopatchBlocks } from "../patching/autopatch/index.js";
import { telemetry } from "../../telemetry.js";
import { patchEditsToBlocks } from "./blocks.js";
import {
  buildLineOffsets,
  lineAtOffset,
  normalizeLineEndings,
  spliceOntoRaw,
} from "../patching/raw-splice.js";
import { resolveToCwd } from "../../shared/paths.js";
import { stripBom, detectLineEnding, normalizeNewlines } from "../text.js";
import { getConfig } from "../../config/settings.js";
import type { AppliedEdit, EditDiagnostic, FailedEdit, NearMissAlternative } from "../model.js";

// Helper: warnings for edits the chain placed SEMANTICALLY (token overlap).
// These matches carry real drift risk: tell the agent where it landed and to
// verify. Surfaced like corruption/coherence advisories — result text,
// details, and the toggleable ctx.ui.notify channel.
function buildSemanticWarnings(applied: AppliedEdit[], content: string): string[] {
  const hits = applied.filter((a) => a.match.passName === "token_overlap");
  if (hits.length === 0) return [];
  const offsets = buildLineOffsets(content);
  return hits.map((a) => {
    const startLine = lineAtOffset(offsets, a.start);
    const endLine = lineAtOffset(offsets, Math.max(a.start, a.end - 1));
    const range = startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
    return `[SEMANTIC MATCH] edits[${a.blockIndex ?? 0}] was placed semantically (token-overlap) at ${range} — the text did not match exactly; re-read and verify the intended change landed correctly.`;
  });
}

// Helper: compute the set of 1-indexed line numbers touched by applied edits.
// Used to scope advisory coherence warnings to the changed region so we do
// not report unrelated historic jumps elsewhere in the file.
function buildFocusLines(content: string, applied: AppliedEdit[]): Set<number> {
  const focus = new Set<number>();
  if (applied.length === 0) return focus;
  const lineOffsets = buildLineOffsets(content);
  for (const a of applied) {
    const startLine = lineAtOffset(lineOffsets, a.start);
    const endLine = lineAtOffset(lineOffsets, Math.max(a.start, a.end - 1));
    for (let line = startLine; line <= endLine; line++) {
      focus.add(line);
    }
  }
  return focus;
}

// Helper: build a human-readable reason for ambiguous diagnostics.
// Replaces the bare status repetition ("ambiguous (ambiguous)") with
// actionable guidance: where the text appears, and how to disambiguate.
export function formatAmbiguousReason(diag: EditDiagnostic, path: string): string {
  if (diag.status !== "ambiguous" || !diag.alternatives || diag.alternatives.length === 0) {
    return diag.reason ?? diag.status;
  }
  const count = diag.alternatives.length;
  const positions = diag.alternatives.map((a) => a.startLine);
  const posStr = positions.map((n) => `line ${n}`).join(", ");
  return (
    `text appears ${count} times at ${posStr} in ${path} — ` +
    "provide more surrounding context, add an anchor, or use replaceAll: true"
  );
}

// Helper: format ambiguous-match alternatives into a compact block.
export function formatAlternatives(
  alternatives: NearMissAlternative[],
  max = 2,
  indent = 0,
): string {
  const prefix = " ".repeat(indent);
  const lines: string[] = [];
  let shown = 0;
  for (const alt of alternatives) {
    if (shown >= max) break;
    const pct = Math.round(alt.similarity * 100);
    const lineRange =
      alt.startLine === alt.endLine
        ? `line ${alt.startLine}`
        : `lines ${alt.startLine}-${alt.endLine}`;
    lines.push(`${prefix}  ${lineRange} (${pct}%): ${alt.candidate.slice(0, 200)}`);
    shown++;
  }
  return lines.length > 0
    ? `\n${prefix}Alternatives (top ${Math.min(shown, alternatives.length)}):\n${lines.join("\n")}`
    : "";
}

export interface ExecuteFileOptions {
  /** Working directory for relative paths. Defaults to process.cwd(). */
  cwd?: string;
  readFile?: (p: string) => Buffer;
  writeFile?: (p: string, data: Buffer | string, encoding?: string) => void;
  rename?: (from: string, to: string) => void;
  exists?: (p: string) => boolean;
  mkdir?: (p: string, opts?: { recursive: boolean }) => void;
  unlink?: (p: string) => void;
  /** Stale-read registry refresh. Called with the raw user path (the key the hook checks). */
  selfRefresh?: (p: string) => void;
  /** pi withFileMutationQueue passthrough (keyed on the resolved path). */
  mutationQueue?: <T>(filePath: string, fn: () => Promise<T>) => Promise<T>;
  /** When true, run the post-edit coherence checker. Defaults to the global config value. */
  coherenceCheckEnabled?: boolean;
}

export interface ExecuteFileResult {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
  details: Record<string, unknown>;
  diagnostics?: EditDiagnostic[];
}

/**
 * Execute a batch of edits against one file. Resolves the path against cwd,
 * reads raw bytes, detects encoding, strips the BOM, normalizes line endings
 * for matching, resolves every edit (multi-pass chain + anchor window), applies,
 * splices the normalized result back onto the ORIGINAL bytes (untouched
 * regions keep their exact bytes — mixed line endings survive), restores the
 * BOM, and writes atomically via tmp-file + rename.
 *
 * Success details also carry `baseContent`/`newContent` (the LF-normalized
 * pre/post-edit content, BOM-free) so the tool layer can build native-shape
 * diff/patch details with pi's generateDiffString/generateUnifiedPatch.
 */
export async function executeFile(
  path: string,
  edits: Array<{ oldText: string; newText: string; anchor?: string; replaceAll?: boolean }>,
  opts: ExecuteFileOptions = {},
): Promise<ExecuteFileResult> {
  const readFile = opts.readFile ?? readFileSync;
  const writeFile = opts.writeFile ?? writeFileSync;
  const rename = opts.rename ?? renameSync;
  const exists = opts.exists ?? existsSync;
  const mkdir = opts.mkdir ?? mkdirSync;
  const unlink = opts.unlink ?? unlinkSync;

  const resolvedPath = resolveToCwd(path, opts.cwd ?? process.cwd());
  const startedAt = performance.now();

  const run = async (): Promise<ExecuteFileResult> => {
    if (edits.length === 0) {
      return {
        content: [{ type: "text", text: "Patch failed: edits array is empty." }],
        isError: true,
        details: { error: "validation", message: "edits array is empty" },
      };
    }

    // 1. Read file content (raw bytes → detect encoding → decode)
    let rawBuffer: Buffer;
    let encoding: "utf-8" | "latin1";
    try {
      rawBuffer = readFile(resolvedPath);
      encoding = detectEncoding(rawBuffer);
    } catch {
      return {
        content: [{ type: "text", text: `Error: file not found: ${path}` }],
        isError: true,
        details: { error: "file-not-found", path },
      };
    }

    const rawContent = rawBuffer.toString(encoding);
    // Strip the BOM before matching — the model will not include an invisible
    // BOM in oldText (native edit parity). Re-prepended on write so the
    // output keeps the original BOM bytes.
    const { bom, text: bomStripped } = stripBom(rawContent);
    const normContent = normalizeLineEndings(bomStripped);

    // 2. Patch edits into blocks
    const blocks = patchEditsToBlocks(edits);

    // 2a. Autopatch passes — fix common model mistakes in oldText/newText
    //     before the fuzzy match chain runs. Mutates blocks in place.
    autopatchBlocks(blocks, normContent);

    // 3. Resolve edits against normalized content
    const outcome = resolveBlocks(normContent, blocks, path);

    if (outcome.resolved.length === 0) {
      const error = outcome.errors[0];
      let message = error.message;

      // Surface compact alternatives for ambiguous failures.
      const ambiguousDiags = outcome.diagnostics?.filter((d) => d.status === "ambiguous") ?? [];
      if (ambiguousDiags.length > 0) {
        const allAlternatives = ambiguousDiags.flatMap((d) => d.alternatives ?? []);
        message += formatAlternatives(allAlternatives, 2);
      }

      return {
        content: [{ type: "text", text: message }],
        isError: true,
        details: {
          error: error.kind,
          message,
          diagnostics: outcome.diagnostics,
        },
      };
    }

    // 4. Apply edits on normalized content. Pass 1 offsets are in the
    //    original coordinate space; Pass 2 offsets are in the post-Pass1
    //    coordinate space, so apply them sequentially and keep their splices
    //    separate so raw-byte reconstruction stays correct.
    const pass1Result = applyEdits(normContent, outcome.pass1Resolved ?? outcome.resolved);
    const pass2Result = outcome.pass2Resolved
      ? applyEdits(pass1Result.content, outcome.pass2Resolved)
      : { content: pass1Result.content, applied: [], failed: [] };
    const result = {
      content: pass2Result.content,
      applied: [...pass1Result.applied, ...pass2Result.applied],
      failed: [...pass1Result.failed, ...pass2Result.failed],
    };
    const allFailures = [...outcome.errors, ...result.failed.map(failureToError)];

    if (result.applied.length === 0 && allFailures.length > 0) {
      const failure = allFailures[0];
      let message = failure.message;

      // Surface compact alternatives for ambiguous failures.
      const ambiguousDiags = outcome.diagnostics?.filter((d) => d.status === "ambiguous") ?? [];
      if (ambiguousDiags.length > 0) {
        const allAlternatives = ambiguousDiags.flatMap((d) => d.alternatives ?? []);
        message += formatAlternatives(allAlternatives, 2);
      }

      return {
        content: [{ type: "text", text: message }],
        isError: true,
        details: {
          error: failure.kind,
          message,
          diagnostics: outcome.diagnostics,
        },
      };
    }

    const partial = result.applied.length > 0 && allFailures.length > 0;

    if (partial) {
      const applyFailedDiagnostics: EditDiagnostic[] = result.failed.map((f: FailedEdit) => ({
        // Structural index from the resolution stage; the triple-findIndex
        // fallback only fires for synthetic failures lacking one. First-match
        // on identical twins is ambiguous, but such failures carry indices.
        index:
          f.blockIndex ??
          blocks.findIndex((b) => b.oldText === f.edit.oldText && b.newText === f.edit.newText),
        oldText: f.edit.oldText,
        newText: f.edit.newText,
        status:
          f.kind === "overlap" || f.kind === "already-handled"
            ? "overlap"
            : f.kind === "no-op"
              ? "noop"
              : "validation",
        reason: f.reason,
      }));
      // Merge: keep all resolve-stage diagnostics, overlay apply-stage failures.
      // Structural EditError.index — message-regex extraction desynced when
      // error TEXT quoted `edits[N]` (mined: docs about this very tool).
      const resolveFailedIndices = new Set(
        outcome.errors.map((e) => e.index).filter((i): i is number => i !== undefined),
      );
      const diagnostics = (
        outcome.diagnostics?.map((d) => {
          if (resolveFailedIndices.has(d.index)) return d;
          const applyFail = applyFailedDiagnostics.find((af) => af.index === d.index);
          if (applyFail) return applyFail;
          return d;
        }) ?? []
      ).concat(
        applyFailedDiagnostics.filter(
          (af) => !outcome.diagnostics?.some((d) => d.index === af.index),
        ),
      );

      const totalEdits = blocks.length;
      const appliedEditCount = new Set(
        result.applied.map((a) => `${a.edit.path}\0${a.edit.oldText}\0${a.edit.newText}`),
      ).size;
      const failedCount = allFailures.length;

      let message = `Applied ${appliedEditCount} of ${totalEdits} edits in ${path}.`;
      if (failedCount > 0) {
        message += `\n${failedCount} edit(s) failed:`;
        // Use diagnostics (which carry the original block index) for resolve
        // failures; fall back to applyEdits failures for application errors.
        const reported = new Set<number>();
        for (const diag of diagnostics) {
          if (diag.status !== "applied") {
            reported.add(diag.index);
            message += `\n  edits[${diag.index}]: ${formatAmbiguousReason(diag, path)}`;
            // Surface compact alternatives for ambiguous failures.
            if (diag.status === "ambiguous" && diag.alternatives && diag.alternatives.length > 0) {
              message += "\n    Alternatives (top 2):";
              for (const alt of diag.alternatives.slice(0, 2)) {
                const pct = Math.round(alt.similarity * 100);
                const lineRange =
                  alt.startLine === alt.endLine
                    ? `line ${alt.startLine}`
                    : `lines ${alt.startLine}-${alt.endLine}`;
                message += `\n    ${lineRange} (${pct}%): ${alt.candidate.slice(0, 200)}`;
              }
            }
          }
        }
        for (const f of result.failed) {
          // Structural first; triple-findIndex only for legacy synthetic
          // failures — and it can misattribute identical twins, which is
          // exactly the phantom-failure line this once printed.
          const idx =
            f.blockIndex ??
            blocks.findIndex((b) => b.oldText === f.edit.oldText && b.newText === f.edit.newText);
          if (idx >= 0 && !reported.has(idx)) {
            reported.add(idx);
            message += `\n  edits[${idx}]: ${f.reason}`;
          }
        }
      }
      // Apply partial edits: splices and write. Apply Pass 1 and Pass 2
      // splices sequentially so each pass's offsets are evaluated against
      // the correct base content.
      const pass1Splices = buildPassSplices(pass1Result.applied);
      const pass2Splices = buildPassSplices(pass2Result.applied);
      const afterPass1Raw = spliceOntoRaw(bomStripped, pass1Splices);
      const newContentRaw = spliceOntoRaw(afterPass1Raw, pass2Splices);
      const newContent = bom + newContentRaw;

      // Advisory structural-integrity check after splices but before write.
      // Detects duplicated content near splice points: line-level duplication
      // from the matched span or adjacent context, prefix echo, and cascading
      // duplicates from earlier edits in the same call.
      const corruptionWarnings = detectDuplicatedBlocks(newContentRaw, result.applied);
      const semanticWarnings = buildSemanticWarnings(result.applied, normContent);

      const dir = resolvedPath.split(/[\\/]/).slice(0, -1).join("/") || ".";
      try {
        if (!exists(dir)) mkdir(dir, { recursive: true });
      } catch {
        // Best-effort; writeFileSync below will surface real errors.
      }

      const tmpPath = `${dir}/.edit-guard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`;
      const postWriteWarnings: string[] = [];
      try {
        const outputBuffer = Buffer.from(newContent, encoding);
        writeFile(tmpPath, outputBuffer);
        rename(tmpPath, resolvedPath);

        // Best-effort post-write re-read verification (see the full-apply
        // path): runs unconditionally, never blocks the result.
        try {
          // Byte equality against what we wrote. Decoding first would
          // false-positive on latin1 files whose replacement text carries
          // characters outside the encoding (em dash, curly quotes): the
          // write truncates them by design, so a decoded round-trip can
          // never equal newContent.
          const reread = readFile(resolvedPath);
          if (!reread.equals(outputBuffer)) {
            postWriteWarnings.push(
              "[CORRUPTION CHECK] Post-write re-read mismatch: file content on disk differs from expected output — possible concurrent modification, encoding truncation (e.g. latin1), or write failure. Please re-read the file to confirm.",
            );
          }
        } catch {
          // best-effort
        }
      } catch (err) {
        try {
          if (exists(tmpPath)) unlink(tmpPath);
        } catch {
          // ignore cleanup errors
        }
        return {
          content: [
            {
              type: "text",
              text: `Error writing file after partial apply: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
          details: { error: "write-failed", message: (err as Error).message },
        };
      }

      if (opts.selfRefresh) {
        try {
          opts.selfRefresh(path);
        } catch {
          // stale-read refresh is best-effort
        }
      }

      const focusLines = buildFocusLines(result.content, result.applied);
      const enabled = opts.coherenceCheckEnabled ?? getConfig().coherenceCheckEnabled;
      const coherenceWarnings = enabled
        ? coherenceCheck(result.content, undefined, focusLines)
        : [];
      const durationMs = Math.round((performance.now() - startedAt) * 10) / 10;
      const passNames = result.applied.map((a: AppliedEdit) => a.match.passName);
      const anchorUsed = outcome.diagnostics?.some((d) => d.match?.anchorUsed === true) ?? false;
      telemetry.record({
        type: "edit.partial",
        timestamp: Date.now(),
        appliedCount: appliedEditCount,
        failedCount,
        passNames,
        durationMs,
      });
      telemetry.record({
        type: "edit.applied",
        timestamp: Date.now(),
        editsApplied: appliedEditCount,
        passNames,
        anchorUsed,
        durationMs,
        coherenceWarnings: coherenceWarnings.length,
      });

      if (corruptionWarnings.length > 0) {
        message += "\n" + corruptionWarnings.join("\n");
      }
      if (semanticWarnings.length > 0) {
        message += "\n" + semanticWarnings.join("\n");
      }

      return {
        content: [{ type: "text", text: message }],
        isError: false,
        details: {
          path,
          isPartial: true,
          appliedCount: appliedEditCount,
          failedCount,
          // Sorted block indices that applied — the tool layer joins these
          // into the "Applied edit indices:" line. A bare count here silently
          // killed that feature (number.length is undefined).
          editsApplied: diagnostics
            .filter((d) => d.status === "applied")
            .map((d) => d.index)
            .sort((a, b) => a - b),
          passNames,
          encoding,
          durationMs,
          bom,
          originalEnding: detectLineEnding(rawContent),
          baseContent: normContent,
          newContent: normalizeNewlines(newContentRaw),
          rawContent: bomStripped,
          rawResult: newContentRaw,
          coherenceWarnings,
          corruptionWarnings,
          postWriteWarnings,
          semanticWarnings,
          diagnostics,
          appliedEdits: result.applied,
          failedEdits: result.failed,
        },
      };
    }
    const pass1Splices = buildPassSplices(pass1Result.applied);
    const pass2Splices = buildPassSplices(pass2Result.applied);
    const afterPass1Raw = spliceOntoRaw(bomStripped, pass1Splices);
    const newContentRaw = spliceOntoRaw(afterPass1Raw, pass2Splices);
    const newContent = bom + newContentRaw;

    // Advisory structural-integrity check after splices but before write.
    const corruptionWarnings = detectDuplicatedBlocks(newContentRaw, result.applied);
    const semanticWarnings = buildSemanticWarnings(result.applied, normContent);

    // 6. Atomic write: temp file + rename in the same directory
    const dir = resolvedPath.split(/[\\/]/).slice(0, -1).join("/") || ".";
    try {
      if (!exists(dir)) mkdir(dir, { recursive: true });
    } catch {
      // Best-effort; writeFileSync below will surface real errors.
    }

    const tmpPath = `${dir}/.edit-guard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`;
    const postWriteWarnings: string[] = [];
    try {
      const outputBuffer = Buffer.from(newContent, encoding);
      writeFile(tmpPath, outputBuffer);
      rename(tmpPath, resolvedPath);

      // Best-effort post-write re-read verification. Surfaces a warning if
      // on-disk bytes differ from expected output. Runs unconditionally —
      // the tool layer already serializes writes via pi's mutation queue,
      // so the re-read cannot interleave with a sibling write.
      try {
        // Byte equality against what we wrote (see the partial-apply path
        // for why decoding first would false-positive on latin1 files).
        const reread = readFile(resolvedPath);
        if (!reread.equals(outputBuffer)) {
          postWriteWarnings.push(
            "[CORRUPTION CHECK] Post-write re-read mismatch: file content on disk differs from expected output — possible concurrent modification, encoding truncation (e.g. latin1), or write failure. Please re-read the file to confirm.",
          );
        }
      } catch {
        // best-effort
      }
    } catch (err) {
      // Clean up the temp file (unlink, not truncate — the old code left
      // empty `.patch-tool-*.tmp` files behind in target directories).
      try {
        if (exists(tmpPath)) unlink(tmpPath);
      } catch {
        // ignore cleanup errors
      }
      return {
        content: [
          {
            type: "text",
            text: `Error writing file: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
        details: { error: "write-failed", message: (err as Error).message },
      };
    }

    // 7. Self-refresh stale-read registry (raw user path — the key the hook checks)
    if (opts.selfRefresh) {
      try {
        opts.selfRefresh(path);
      } catch {
        // stale-read refresh is best-effort
      }
    }

    // Advisory coherence warnings on the result content (non-blocking).
    // Surfaced in result text, details.guard, and the edit.applied telemetry event below.
    const focusLines = buildFocusLines(result.content, result.applied);
    const enabled = opts.coherenceCheckEnabled ?? getConfig().coherenceCheckEnabled;
    const coherenceWarnings = enabled ? coherenceCheck(result.content, undefined, focusLines) : [];

    const durationMs = Math.round((performance.now() - startedAt) * 10) / 10;
    const passNames = result.applied.map((a: AppliedEdit) => a.match.passName);
    const anchorUsed = outcome.diagnostics?.some((d) => d.match?.anchorUsed === true) ?? false;
    telemetry.record({
      type: "edit.applied",
      timestamp: Date.now(),
      editsApplied: result.applied.length,
      passNames,
      anchorUsed,
      durationMs,
      coherenceWarnings: coherenceWarnings.length,
    });

    const successText = `Patched ${path}: ${result.applied.length} edit(s) applied.`;
    const allWarnings = [...semanticWarnings, ...corruptionWarnings, ...postWriteWarnings];
    const text = allWarnings.length > 0 ? `${successText}\n${allWarnings.join("\n")}` : successText;

    return {
      content: [
        {
          type: "text",
          text,
        },
      ],
      isError: false,
      details: {
        path,
        // Sorted block indices that applied (see the partial-apply path).
        editsApplied: result.applied
          .map((a: AppliedEdit) => a.blockIndex)
          .filter((i): i is number => i !== undefined)
          .sort((a, b) => a - b),
        passNames,
        encoding,
        durationMs,
        bom,
        originalEnding: detectLineEnding(rawContent),
        // BOM-free LF-normalized pre/post content for native-shape diff/patch
        // construction by the tool layer (base = pre-edit, new = post-edit).
        baseContent: normContent,
        newContent: result.content,
        rawContent: bomStripped,
        rawResult: newContentRaw,
        coherenceWarnings,
        corruptionWarnings,
        postWriteWarnings,
        semanticWarnings,
        diagnostics: outcome.diagnostics?.filter((d) => d.status === "applied"),
      },
    };
  };

  if (opts.mutationQueue) {
    return opts.mutationQueue(resolvedPath, run);
  }
  return run();
}

function detectDuplicatedBlocks(postEditContent: string, applied: AppliedEdit[]): string[] {
  const warnings: string[] = [];
  const sorted = [...applied].sort((a, b) => a.start - b.start);
  const offsets = new Map<AppliedEdit, { start: number; end: number }>();
  let shift = 0;
  for (const edit of sorted) {
    const postStart = edit.start + shift;
    const postEnd = postStart + edit.edit.newText.length;
    offsets.set(edit, { start: postStart, end: postEnd });
    shift += edit.edit.newText.length - (edit.end - edit.start);
  }

  const CONTEXT_WINDOW = 64;

  for (const a of applied) {
    const newText = normalizeNewlines(a.edit.newText);
    const { start: postStart, end: postEnd } = offsets.get(a)!;
    const before = postEditContent.slice(Math.max(0, postStart - CONTEXT_WINDOW), postStart);
    const after = postEditContent.slice(
      postEnd,
      Math.min(postEditContent.length, postEnd + CONTEXT_WINDOW),
    );

    // Skip short replacements — they rarely duplicate whole blocks
    // and are the main source of false-positive corruption warnings.
    if (newText.length < 120) {
      continue;
    }

    const matchedLines = a.match.actual.split("\n");
    const newLines = newText.split("\n");

    const isStructural = (line: string) => /^\s*[}\])],;]+\s*$/.test(line);

    // Helper: detect whether target contains a consecutive sequence of
    // minSeq non-empty, non-structural lines from source. Both source and
    // target are filtered so the comparison is symmetric.
    const hasConsecutiveSequence = (source: string[], target: string[], minSeq: number) => {
      const trimmedSource = source
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !isStructural(l));
      const trimmedTarget = target
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !isStructural(l));
      if (trimmedSource.length < minSeq || trimmedTarget.length < minSeq) return false;
      const candidates = new Set<string>();
      for (let i = 0; i <= trimmedSource.length - minSeq; i++) {
        candidates.add(trimmedSource.slice(i, i + minSeq).join("\n"));
      }
      for (let i = 0; i <= trimmedTarget.length - minSeq; i++) {
        const seq = trimmedTarget.slice(i, i + minSeq).join("\n");
        if (candidates.has(seq)) return true;
      }
      return false;
    };

    // Line-level duplication from the matched block.
    // Single-line matches cannot meaningfully duplicate themselves at line
    // level — use the prefix-echo check instead. For multi-line matches,
    // require a consecutive sequence to avoid scattered-line false positives.
    // Tuned 2026-09: previous thresholds (expansion >=2 for 100+ chars, 0.5/0.2)
    // produced ~90% false positives in the wild (59 warnings in 10 days, most
    // were legitimate expansions retaining header lines). New thresholds require
    // larger expansions AND higher duplication density AND internal duplicate
    // in newText, which is the true corruption signal (newText repeating a
    // block that already existed in the matched region).
    if (matchedLines.length > 1) {
      const minSeq = matchedLines.length > 30 ? 5 : 4;
      const expansionRatio = newText.length / Math.max(1, a.match.actual.length);
      const suspiciousExpansion =
        a.match.actual.length >= 200
          ? expansionRatio >= 3.5
          : a.match.actual.length >= 100
            ? expansionRatio >= 4
            : expansionRatio >= 6;
      if (suspiciousExpansion) {
        const duplicatedMatchedLines = matchedLines
          .map((l) => l.trim())
          .filter((l) => l.length > 0 && !isStructural(l));
        const duplicatedNewLines = newLines
          .map((l) => l.trim())
          .filter((l) => l.length > 0 && !isStructural(l));
        const matchedLineCount = duplicatedMatchedLines.length;
        const minDuplicatedCount = Math.max(minSeq, Math.ceil(matchedLineCount * 0.7));
        const matchedLineSet = new Set(duplicatedMatchedLines);
        const duplicatedCount = duplicatedNewLines.filter((l) => matchedLineSet.has(l)).length;
        const hasConsecutive = hasConsecutiveSequence(matchedLines, newLines, minSeq);
        // True corruption repeats a block inside newText itself (e.g. copy-paste
        // duplication where newText contains the same 5-line block twice).
        const hasInternalDuplicate = (() => {
          if (duplicatedNewLines.length < minSeq * 2) return false;
          const seen = new Set<string>();
          for (let i = 0; i <= duplicatedNewLines.length - minSeq; i++) {
            const seq = duplicatedNewLines.slice(i, i + minSeq).join("\n");
            if (seen.has(seq)) return true;
            seen.add(seq);
          }
          return false;
        })();
        if (
          hasConsecutive &&
          hasInternalDuplicate &&
          duplicatedCount >= minDuplicatedCount &&
          duplicatedCount / matchedLineCount >= 0.7 &&
          duplicatedCount / Math.max(1, duplicatedNewLines.length) >= 0.4
        ) {
          warnings.push(
            `[CORRUPTION CHECK] edits[${a.blockIndex ?? 0}]: inserted text appears to duplicate a consecutive block from the matched block — verify the file does not contain a duplicated code block (the new content may have re-inserted ${minSeq}+ lines that already existed in the replaced text).`,
          );
        }
      }
    }

    // Line-level duplication from adjacent context (before/after splice).
    const beforeLines = before
      .trim()
      .split("\n")
      .filter((l) => l.trim().length > 0);
    const afterLines = after
      .trim()
      .split("\n")
      .filter((l) => l.trim().length > 0);

    const contextLineOccurrences = newLines.filter(
      (l) => beforeLines.includes(l) || afterLines.includes(l),
    ).length;
    const totalContextLines = beforeLines.length + afterLines.length;
    // 2026-09: keep 5 consecutive, 0.7 density but fix to only warn on the
    // side that actually matched (previous OR pushed both even when only one
    // side matched).
    const beforeDup = hasConsecutiveSequence(beforeLines, newLines, 5);
    const afterDup = hasConsecutiveSequence(afterLines, newLines, 5);
    if (totalContextLines > 0 && contextLineOccurrences / newLines.length >= 0.7) {
      if (beforeDup) {
        warnings.push(
          `[CORRUPTION CHECK] edits[${a.blockIndex ?? 0}]: inserted text appears to duplicate code from surrounding context before the edit (duplicates context before the splice) — verify the file does not contain a duplicated block adjacent to the change.`,
        );
      }
      if (afterDup) {
        warnings.push(
          `[CORRUPTION CHECK] edits[${a.blockIndex ?? 0}]: inserted text appears to duplicate code from surrounding context after the edit (duplicates context after the splice) — verify the file does not contain a duplicated block adjacent to the change.`,
        );
      }
    }

    // Prefix echo (runs for both single-line and multi-line matches).
    // Single-line matches like `class Foo {}` often expand to `class Foo {\n  ...\n}`
    // where the exact prefix doesn't align on a line boundary, but 24 chars
    // avoids false positives from short structural prefixes.
    // The ratio threshold scales with minPrefixLen to avoid
    // false negatives when the prefix is long.
    const minPrefixLen = 24;
    // 2026-09: raised from 20→24 and ratio 0.05→0.08 plus expansion 2×→3× to
    // cut prefix-echo false positives (131 in 30 days, many were single-line
    // expansions like `class Foo {` → `class Foo {\n  field`). True prefix
    // echo repeats a 24+ char header twice inside a large insertion.
    const trimmedPrefix = a.match.actual.trimStart();
    if (trimmedPrefix.length > 0 && newText.length >= a.match.actual.length * 3) {
      let prefixLen = Math.min(32, trimmedPrefix.length);
      while (prefixLen >= minPrefixLen) {
        const prefix = trimmedPrefix.slice(0, prefixLen);
        if (newText.startsWith(prefix)) {
          const searchStart = Math.floor(newText.length * 0.3);
          if (newText.slice(searchStart).includes(prefix)) {
            const prefixRatio = prefix.length / newText.length;
            if (prefixRatio >= 0.08) {
              warnings.push(
                `[CORRUPTION CHECK] edits[${a.blockIndex ?? 0}]: inserted text appears to duplicate the matched block ("${prefix}"...) — verify the new content does not contain the old block twice (header repeated).`,
              );
            }
            break;
          }
        }
        prefixLen--;
      }
    }

    // Cascading duplicate: the post-edit context already contains this inserted
    // text (from another applied edit). Kept for completeness but rarely fires
    // (requires newText <32 chars, below the 120-char skip) — left as advisory.
    const beforePrefix = before.slice(-32);
    const afterPrefix = after.slice(0, 32);

    if (newText.length > 0 && beforePrefix && beforePrefix.includes(newText)) {
      warnings.push(
        `[CORRUPTION CHECK] edits[${a.blockIndex ?? 0}]: inserted text appears elsewhere in the file already (duplicates context already inserted before it) — verify no unintended duplication from a prior edit in the same call.`,
      );
    }
    if (newText.length > 0 && afterPrefix && afterPrefix.includes(newText)) {
      warnings.push(
        `[CORRUPTION CHECK] edits[${a.blockIndex ?? 0}]: inserted text appears elsewhere in the file already (duplicates context already inserted after it) — verify no unintended duplication from a prior edit in the same call.`,
      );
    }
  }
  return warnings;
}

/**
 * Detect file encoding from a Buffer. Returns the encoding string to use
 * for Buffer.toString() / Buffer.from().
 *
 * Priority:
 *   1. UTF-8 BOM (EF BB BF) → "utf-8"
 *   2. Valid UTF-8 (all byte sequences decode cleanly) → "utf-8"
 *   3. Fallback → "latin1" (1:1 byte mapping, never fails)
 */
function detectEncoding(buffer: Buffer): "utf-8" | "latin1" {
  // BOM check
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return "utf-8";
  }
  // Try UTF-8: decode and re-encode — if equal, it's valid UTF-8
  const asUtf8 = buffer.toString("utf-8");
  if (Buffer.from(asUtf8, "utf-8").equals(buffer)) {
    return "utf-8";
  }
  return "latin1";
}
