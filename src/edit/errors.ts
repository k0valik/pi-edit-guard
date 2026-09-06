// Pure error/message builders. All messages are strings derived from domain
// results — no Pi imports, unit-testable. The pi/tool layer wires these into
// tool output.

import { formatLinePositions } from "./pipeline/uniqueness.js";
import type { ClosestCandidate, EditError } from "./model.js";

export function staleReadError(): EditError {
  return {
    kind: "stale-read",
    message:
      "The file has changed since you last read it; re-read the file and retry your edit with the current content.",
  };
}

export function ambiguousError(path: string, count: number, positions: number[]): EditError {
  return {
    kind: "ambiguous",
    message:
      `oldText found ${count} times at ${formatLinePositions(positions)} in ${path}. ` +
      "Provide more surrounding context to make the match unique, or set replaceAll: true " +
      "to replace every occurrence.",
    linePositions: positions,
  };
}

export function anchorNotFoundError(path: string, closest?: ClosestCandidate): EditError {
  const base = `anchor not found in ${path} — remove it or provide text from the file.`;
  if (!closest) {
    return { kind: "anchor-not-found", message: base };
  }
  const pct = Math.round(closest.similarity * 100);
  const lines =
    closest.startLine === closest.endLine
      ? `line ${closest.startLine}`
      : `lines ${closest.startLine}-${closest.endLine}`;
  const preview = abbreviate(closest.candidate);
  return {
    kind: "anchor-not-found",
    message:
      `${base}\n` +
      `Closest match (${pct}% similar) at ${lines}:\n${preview}\n` +
      "Anchor status: the anchor has no verbatim occurrence in the file.\n" +
      "Compare against the actual file content and retry with the correct text.",
    closestCandidate: closest,
  };
}

export function anchorAmbiguousError(path: string, count: number, positions: number[]): EditError {
  return {
    kind: "anchor-ambiguous",
    message:
      `anchor found ${count} times at ${formatLinePositions(positions)} in ${path} — ` +
      "provide a more distinctive anchor that appears only once.",
    linePositions: positions,
  };
}

export function notFoundError(
  path: string,
  closest?: ClosestCandidate,
  anchorNote?: string,
): EditError {
  const base = `Could not find oldText in ${path}. The intended edit could not be applied.`;
  if (!closest) {
    return { kind: "not-found", message: base };
  }
  const pct = Math.round(closest.similarity * 100);
  const lines =
    closest.startLine === closest.endLine
      ? `line ${closest.startLine}`
      : `lines ${closest.startLine}-${closest.endLine}`;
  const preview = abbreviate(closest.candidate);
  const note =
    anchorNote ??
    "Anchor status: none provided — supply unique nearby context to narrow the search.";
  return {
    kind: "not-found",
    message:
      `${base}\n` +
      `Closest match (${pct}% similar) at ${lines}:\n${preview}\n` +
      `${note}\n` +
      "Compare against the actual file content and retry with the correct text.",
    closestCandidate: closest,
  };
}

/**
 * oldText missed (full-content, after every fallback), but newText is
 * present verbatim. Presence is NOT proof of placement: the mined misfire
 * corpus (deepseek-newtool-session 2026-08-25) shows newText occurring
 * naturally at unrelated sites — and both v4-flash and v4-pro BELIEVED the
 * bare claim and wasted turns verifying. So the claim always carries its
 * evidence (occurrence lines) as falsifiable, checkable information.
 */
export function alreadyAppliedError(
  path: string,
  replaceOccurrences?: { count: number; positions: number[] },
): EditError {
  const evidence =
    replaceOccurrences && replaceOccurrences.positions.length > 0
      ? ` The newText occurs at ${formatLinePositions(replaceOccurrences.positions)} — verify whether those sites are your targets before acting on this.`
      : "";
  return {
    kind: "already-applied",
    message:
      `Could not find oldText in ${path}, but the newText is already present in the ` +
      `file.${evidence} If those sites match your intent, this edit appears to be already applied.`,
  };
}

export function overlappingError(description: string): EditError {
  return { kind: "overlapping", message: `Overlapping edits: ${description}` };
}

export function noOpError(): EditError {
  return {
    kind: "no-op",
    message: "Edit results in no change: the replacement text is identical to the matched text.",
  };
}

export function validationError(message: string): EditError {
  return { kind: "validation", message };
}

export function disproportionateError(path: string): EditError {
  return {
    kind: "disproportionate",
    message:
      `Refusing to edit ${path}: the matched span is much larger than the text to find. ` +
      "Re-read the file and provide the full exact text for the intended replacement.",
  };
}

/** Truncate multi-line candidate text for a compact error preview. */
function abbreviate(text: string, maxLines = 8, maxCols = 80): string {
  const lines = text.split("\n").slice(0, maxLines);
  const abridged = lines.map((l) => (l.length > maxCols ? l.slice(0, maxCols) + "…" : l));
  if (text.split("\n").length > maxLines) abridged.push("…");
  let out = abridged.join("\n");
  // Hard cap for wire-size: avoid replaying a 2k-line misplaced edit into context.
  // Built-in edit surfaces only a short preview; we keep closest-match helper but cap it.
  const LIMIT = 200;
  if (out.length > LIMIT) {
    out = out.slice(0, LIMIT).trimEnd() + " … (truncated)";
  }
  return out;
}
