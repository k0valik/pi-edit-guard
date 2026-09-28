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
      return { actual: expandToLineTail(orig, old, actual), passName: name };
    }
  }
  return null;
}

/**
 * Whole-line trailing expansion — a single-line query that names a line
 * modulo surrounding whitespace widens a sub-line hit to the line's end so
 * full-line replaces strip trailing whitespace (benchmark whitespace-only:
 * `bbb` against `bbb␣␣` yields `BBB`, not `BBB␣␣`).
 *
 * Narrow by construction: multi-line queries and multi-line hits pass
 * through, mid-line tokens (`limit=100` inside a URL line, `deploy` inside
 * YAML lines) keep substring semantics because the query never equals the
 * whole line after trim, and leading indentation is never absorbed — the
 * head of the hit stays where the pass put it, only the tail widens.
 */
function expandToLineTail(orig: string, old: string, actual: string): string {
  if (old.includes("\n") || actual.includes("\n")) return actual;
  const idx = orig.indexOf(actual);
  if (idx === -1) return actual;
  const lineEnd = orig.indexOf("\n", idx);
  const end = lineEnd === -1 ? orig.length : lineEnd;
  const lineStart = orig.lastIndexOf("\n", idx - 1) + 1;
  const line = orig.slice(lineStart, end);
  if (line.trim() !== old.trim()) return actual;
  if (idx + actual.length >= end) return actual;
  return orig.slice(idx, end);
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
 *
 * Single-line queries resolve here only on a whitespace-collapsed whole-line
 * hit (see implementation): a bare substring inside a longer drifted line
 * is content drift, not whitespace drift, and keeps the hard block.
 */
export function isWhitespaceTolerantMatch(original: string, oldContent: string): boolean {
  if (oldContent.length === 0) return false;
  const orig = normalizeNewlines(original);
  const old = normalizeNewlines(oldContent);
  // Single-line queries must name a whole line (whitespace-collapsed):
  // substring containment inside a longer drifted line (`bbb` inside
  // `bbb-external`) is content drift, not whitespace drift — the stale-read
  // guard must keep its first-contact block there (benchmark
  // stale-line/b9/error-guidance). Collapse keeps genuine respace tolerance
  // (`a  b` still matches `a b`); trim keeps indent/trailing-space tolerance.
  if (!old.includes("\n")) {
    const want = old.replace(/\s+/g, " ").trim();
    if (want.length === 0) return false;
    return orig.split("\n").some((line) => line.replace(/\s+/g, " ").trim() === want);
  }
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
