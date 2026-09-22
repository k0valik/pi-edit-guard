import { REPLACER_CHAIN } from "./passes.js";
import {
  indentationFlexibleFind,
  lineTrimmedFind,
  simpleFind,
  whitespaceNormalizedFind,
} from "./passes.js";
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
    // An empty `actual` is never a valid match (issue #4). Skipping it also
    // lets later passes get a chance instead of committing to the bug.
    if (actual !== null && actual.length > 0) {
      return { actual, passName: name };
    }
  }
  return null;
}

/**
 * Whitespace-only-tolerant resolution — Tier 1-3 passes that change nothing
 * but whitespace between query and match:
 *   - simple (verbatim, line-aligned for multi-line since the graft law)
 *   - line_trimmed (per-line trim)
 *   - whitespace_normalized (whitespace-run collapse per line)
 *   - indentation_flexible (leading-indent + blank-line tolerance)
 *
 * Deliberately EXCLUDED: escape_normalized / unicode_normalized (they
 * tolerate model-side encoding differences, not file drift) and every
 * fuzzy tier (anchored, legacy, reinforcement, token-multiset — all can
 * bridge genuine content drift).
 *
 * Consumed by the stale-read guard: when every search text resolves here
 * against current bytes, drift is provably whitespace-only and the edit
 * proceeds with an advisory instead of a hard block. A match here means
 * the splice lands deterministically — the drift cannot redirect it.
 */
export function isWhitespaceTolerantMatch(original: string, oldContent: string): boolean {
  if (oldContent.length === 0) return false;
  const orig = normalizeNewlines(original);
  const old = normalizeNewlines(oldContent);
  const finds = [simpleFind, lineTrimmedFind, whitespaceNormalizedFind, indentationFlexibleFind];
  for (const find of finds) {
    const actual = find(orig, old);
    if (actual !== null && actual.length > 0) return true;
  }
  return false;
}

/**
 * Run only the passes STRICTLY STRONGER than (earlier in REPLACER_CHAIN
 * than) `weakerPassName` against the full content.
 *
 * Used by the anchor-window shadow guard (pipeline/resolve.ts): a weak
 * window hit (e.g. token_overlap) must not shadow a unique stronger
 * full-file match (e.g. verbatim simple). Returns the first stronger hit
 * or null when none fires. Unknown pass names yield null (no override).
 */
export function findMatchStrongerThan(
  original: string,
  oldContent: string,
  weakerPassName: string,
): MatchResult | null {
  const cutoff = REPLACER_CHAIN.findIndex(({ name }) => name === weakerPassName);
  if (cutoff <= 0) return null;
  const orig = normalizeNewlines(original);
  const old = normalizeNewlines(oldContent);

  for (const { name, find } of REPLACER_CHAIN.slice(0, cutoff)) {
    const actual = find(orig, old);
    // Same empty-match invariant as findMatch (issue #4).
    if (actual !== null && actual.length > 0) {
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
  // `indexOf("", pos)` always returns `pos`, so an empty needle never
  // advances `searchPos` — the loop would push positions forever and OOM
  // (issue #4). An empty needle has no meaningful occurrence positions.
  if (needle === "") return positions;
  let searchPos = 0;
  while (searchPos <= haystack.length) {
    const idx = haystack.indexOf(needle, searchPos);
    if (idx === -1) break;
    positions.push(haystack.slice(0, idx).split("\n").length); // newlines + 1
    searchPos = idx + needle.length;
  }
  return positions;
}
