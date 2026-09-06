/**
 * Apply phase — splices resolved edits onto content, bottom-up.
 *
 * Input is ResolvedEdit[] (from pipeline/resolve.ts) with LF-normalized
 * offsets into the original content. The applier (1) detects overlapping
 * spans on the ORIGINAL coordinate space before any replacement, (2) sorts
 * pieces by descending start so indices stay valid as it splices, and (3)
 * classifies failures: overlap/already-handled (span collision), no-op
 * (including the "already applied" fuzzy-match variant), and invariant
 * (span no longer at expected offset). Overlaps are not guessed — both
 * participants fail explicitly.
 */

import type { ApplyResult, ResolvedEdit } from "../model.js";
import { ALREADY_APPLIED_MIN_CHARS, normalizeNewlines } from "../text.js";

export function applyEdits(content: string, resolved: ResolvedEdit[]): ApplyResult {
  const applied: ApplyResult["applied"] = [];
  const failed: ApplyResult["failed"] = [];

  if (resolved.length === 0) {
    return { content, applied, failed };
  }

  // Detect overlaps on the ORIGINAL content before any replacement.
  const sorted = [...resolved].sort((a, b) => {
    const startDiff = a.start - b.start;
    if (startDiff !== 0) return startDiff;
    // Secondary: wider span first (higher end), then by oldText for stability.
    const endDiff = b.end - a.end;
    if (endDiff !== 0) return endDiff;
    return a.edit.oldText < b.edit.oldText ? -1 : a.edit.oldText > b.edit.oldText ? 1 : 0;
  });
  const overlapCandidates = new Set<ResolvedEdit["edit"]>();
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[i].start < sorted[j].end && sorted[j].start < sorted[i].end) {
        overlapCandidates.add(sorted[i].edit);
        overlapCandidates.add(sorted[j].edit);
      }
    }
  }

  // Apply bottom-up (highest start first) so indices stay valid.
  const pieces: { start: number; end: number; replacement: string; edit: ResolvedEdit }[] = [];
  for (const r of resolved) {
    const replacement = normalizeNewlines(r.edit.newText);
    pieces.push({ start: r.start, end: r.end, replacement, edit: r });
  }
  pieces.sort((a, b) => {
    const startDiff = b.start - a.start;
    if (startDiff !== 0) return startDiff;
    // Sort by start descending (apply highest spans first) then by end descending
    // so that overlapping edits are applied in stable order. Indices remain valid
    // because each replacement only affects positions after the current splice.
    const endDiff = b.end - a.end;
    if (endDiff !== 0) return endDiff;
    return a.edit.edit.oldText < b.edit.edit.oldText
      ? -1
      : a.edit.edit.oldText > b.edit.edit.oldText
        ? 1
        : 0;
  });

  let result = content;
  for (const p of pieces) {
    const noOp = p.replacement === p.edit.match.actual;
    if (noOp) {
      // Distinguish "model sent identical text" from "target state already
      // present": a fuzzy (non-simple) pass matched a span equal to the
      // replacement while the SEARCH text differs — the edit was already
      // applied earlier (observed in the wild after partial retries).
      // False-positive guard: only claim this when the matched span itself is
      // substantial; a tiny fuzzy span equal to the replacement is too weak
      // evidence that the intended edit already happened.
      const intendedChange = normalizeNewlines(p.edit.edit.oldText) !== p.replacement;
      const substantialSpan = p.edit.match.actual.length >= ALREADY_APPLIED_MIN_CHARS;
      failed.push({
        edit: p.edit.edit,
        blockIndex: p.edit.blockIndex,
        kind: "no-op",
        reason:
          intendedChange && substantialSpan && p.edit.match.passName !== "simple"
            ? "already applied: the REPLACE text is already present in the file"
            : "edit results in no change (old and new text identical after normalization)",
      });
      continue;
    }
    // Guard: the actual text must still be present at this span.
    if (result.slice(p.start, p.end) !== p.edit.match.actual) {
      if (overlapCandidates.has(p.edit.edit)) {
        failed.push({
          edit: p.edit.edit,
          blockIndex: p.edit.blockIndex,
          kind: "already-handled",
          reason: "overlapping edit already handled by a prior edit",
        });
        continue;
      }
      failed.push({
        edit: p.edit.edit,
        blockIndex: p.edit.blockIndex,
        kind: "invariant",
        reason: "internal invariant violated: actual text not found at resolved span",
      });
      continue;
    }
    result = result.slice(0, p.start) + p.replacement + result.slice(p.end);
    applied.push({
      edit: p.edit.edit,
      match: p.edit.match,
      start: p.start,
      end: p.end,
      blockIndex: p.edit.blockIndex,
    });
  }

  return { content: result, applied, failed };
}
