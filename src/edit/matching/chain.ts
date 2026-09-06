import { REPLACER_CHAIN } from "./passes.js";
import type { MatchResult } from "../model.js";
import { normalizeNewlines } from "../text.js";

/**
 * Chain executor — walks REPLACER_CHAIN in order, short-circuiting on the
 * first hit (see passes.ts for tier grouping and pass semantics).
 *
 * Both inputs are LF-normalized first (port of OpenDev's find_match()). Each
 * pass returns verbatim file text or null; the winner's `actual` + `passName`
 * become the MatchResult. No occurrence counting here — uniqueness is enforced
 * by the caller (pipeline/resolve.ts).
 *
 * `allowSearchOnly: false` excludes heuristic search-only passes (fuzzy_boundary,
 * token_overlap). Used for ANCHOR lookups, where a fuzz-found anchor could
 * silently re-anchor an edit to a wrong-but-similar region and defeat the
 * redundant-anchor guard.
 */
export function findMatch(
  original: string,
  oldContent: string,
  opts: { allowSearchOnly?: boolean } = {},
): MatchResult | null {
  const { allowSearchOnly = true } = opts;
  const orig = normalizeNewlines(original);
  const old = normalizeNewlines(oldContent);

  for (const { name, find, searchOnly } of REPLACER_CHAIN) {
    if (searchOnly && !allowSearchOnly) continue;
    const actual = find(orig, old);
    if (actual !== null) {
      return { actual, passName: name };
    }
  }
  return null;
}

/**
 * 1-indexed line numbers of every occurrence of `needle` in `haystack`.
 * Uses character-offset splitting so empty lines and mixed endings are counted correctly.
 */
export function findOccurrencePositions(haystack: string, needle: string): number[] {
  const positions: number[] = [];
  let searchPos = 0;
  while (searchPos <= haystack.length) {
    const idx = haystack.indexOf(needle, searchPos);
    if (idx === -1) break;
    positions.push(haystack.slice(0, idx).split("\n").length); // newlines + 1
    searchPos = idx + needle.length;
  }
  return positions;
}
