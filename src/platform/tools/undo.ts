/**
 * Undo tool — reverts the most recent edit made by the edit tool on a file.
 *
 * Uses the JSON-file-backed undo store (src/history/store.ts) for
 * single-level per-file undo. Staleness detection is via raw-byte comparison
 * of the current file against the stored resultContent + BOM + line ending.
 *
 * Gated by `undoEnabled` in EditGuardConfig.
 */

import { readFile, writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { resolveToCwd } from "../../shared/paths.js";
import { restoreLineEndings } from "../../edit/text.js";
import { getUndo, clearUndo, type UndoRecord } from "../../history/store.js";
import { getConfig } from "../../config/settings.js";

/** Humanize snapshot age for provenance output ("just now", "5m ago", ...). */
function formatAge(ms: number): string {
  if (ms < 45_000) return "just now";
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** "2h ago by session s-ab12cd4" — provenance suffix for a stored snapshot. */
function describeSnapshot(undo: UndoRecord): string {
  const age = formatAge(Math.max(0, Date.now() - undo.updatedAt));
  const origin = undo.sessionId ? ` by session ${undo.sessionId.slice(0, 8)}` : "";
  return `${age}${origin}`;
}

export function registerUndoTool(pi: ExtensionAPI): void {
  const cfg = getConfig();

  // Killswitch: when disabled, do not register.
  if (!cfg.undoEnabled) return;

  pi.registerTool({
    name: "undo",
    label: "Undo Last Edit",
    description:
      "Revert your most recent edit to a file in one call, restoring its exact pre-edit content. The quick escape hatch for mistaken edits — far cheaper than hand-reverting or discarding the file, and it touches nothing beyond that one revert.",
    promptSnippet: "Revert the most recent edit-tool change on a file",
    promptGuidelines: [
      "When your last edit to a file turns out wrong, use undo to take it back instead of hand-reverting or rewriting the file.",
    ],
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path of the file whose last edit-tool change should be reverted",
        },
      },
      required: ["path"],
    },
    async execute(_toolCallId, params: { path: string }, signal, _onUpdate, ctx) {
      const absolutePath = resolveToCwd(params.path, ctx.cwd);
      const throwIfAborted = () => {
        if (signal?.aborted) throw new Error("Operation aborted");
      };
      throwIfAborted();
      const undo = getUndo(absolutePath);
      if (!undo) {
        return {
          content: [
            {
              type: "text",
              text: `[E_UNDO_STALE] No undo history for ${absolutePath}. The tool keeps a single snapshot per file (from the most recent edit-tool edit); there is nothing to revert.`,
            },
          ],
          isError: true,
          details: {},
        };
      }

      return withFileMutationQueue(absolutePath, async () => {
        throwIfAborted();

        let currentRaw: string | undefined;
        try {
          currentRaw = await readFile(absolutePath, undo.encoding);
        } catch {
          clearUndo(absolutePath);
          return {
            content: [
              {
                type: "text",
                text: `[E_UNDO_STALE] Cannot undo ${absolutePath}: the file no longer exists (snapshot captured ${describeSnapshot(undo)}). Call read() to inspect the current state.`,
              },
            ],
            isError: true,
            details: {},
          };
        }

        const expectedRaw = undo.rawResult
          ? undo.bom + undo.rawResult
          : undo.bom + restoreLineEndings(undo.resultContent, undo.originalEnding);
        if (currentRaw !== expectedRaw) {
          clearUndo(absolutePath);
          return {
            content: [
              {
                type: "text",
                text: `[E_UNDO_STALE] Cannot undo ${absolutePath}: the file changed since the snapshot was captured (${describeSnapshot(undo)}). Re-read the file and verify the edit you want reverted, then decide whether a fresh targeted edit is safer.`,
              },
            ],
            isError: true,
            details: {},
          };
        }

        throwIfAborted();

        const restored = undo.rawContent
          ? undo.bom + undo.rawContent
          : undo.bom + restoreLineEndings(undo.content, undo.originalEnding);
        await writeFile(absolutePath, restored, undo.encoding);
        clearUndo(absolutePath);

        return {
          content: [
            {
              type: "text",
              text: `Undid last edit on ${absolutePath}. Restored the state captured ${describeSnapshot(undo)}. Call read() to inspect.`,
            },
          ],
          details: {},
        };
      });
    },
  });
}
