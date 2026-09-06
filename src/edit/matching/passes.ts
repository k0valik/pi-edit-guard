/**
 * Multi-pass text matching chain — 13 fuzzy passes + verbatim.
 *
 * Each pass is a pure function `find(original, oldContent) -> actual | null` where
 * `actual` is ALWAYS verbatim file text (never the query), so replacements preserve
 * real formatting. Inputs are LF-normalized by the caller (chain.ts).
 *
 * Definition order ≠ execution order — the authoritative order is REPLACER_CHAIN at
 * the bottom of this file. Passes are grouped into 7 tiers by precision (see
 * "Chain registry" docs below); earlier tiers shadow later ones on first hit.
 */
//

import { intersectSize, similarity, similarityUpperBound, tokenCounts } from "./similarity.js";
import { robustTrimmedFind, robustBackslashFind } from "./robust-match.js";

export type PassFind = (original: string, oldContent: string) => string | null;

// ---------------------------------------------------------------------------
// Tier 1: Simple — exact string match
// ---------------------------------------------------------------------------

export function simpleFind(original: string, oldContent: string): string | null {
  return original.includes(oldContent) ? oldContent : null;
}

// ---------------------------------------------------------------------------
// Tier 2: LineTrimmed — trim each line before comparing (absorbed multi_occurrence)
// ---------------------------------------------------------------------------

export function lineTrimmedFind(original: string, oldContent: string): string | null {
  // Absorbs the former multi_occurrence pass: strip blank-line frames from the
  // query so a leading/trailing empty line cannot anchor the search on a blank
  // line. Interior blank lines are still matched verbatim (trimmed).
  let oldLines = oldContent.split("\n");
  while (oldLines.length > 1 && oldLines[0]!.trim().length === 0) {
    oldLines = oldLines.slice(1);
  }
  while (oldLines.length > 1 && oldLines[oldLines.length - 1]!.trim().length === 0) {
    oldLines = oldLines.slice(0, -1);
  }

  const oldTrimmed = oldLines.map((l) => l.trim());

  if (oldTrimmed.every((l) => l.length === 0)) return null;

  const originalLines = original.split("\n");

  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i].trim() !== oldTrimmed[0]) continue;
    if (i + oldTrimmed.length > originalLines.length) continue;
    const allMatch = oldTrimmed.every((oldLn, j) => originalLines[i + j].trim() === oldLn);
    if (allMatch) {
      const actual = originalLines.slice(i, i + oldTrimmed.length).join("\n");
      if (original.includes(actual)) return actual;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tier 4 (anchored fuzzy): BlockAnchor — first/last lines anchor, middle
// scored by LCS similarity. Execution order: after Tier 3 (see REPLACER_CHAIN).
// ---------------------------------------------------------------------------

export function blockAnchorFind(original: string, oldContent: string): string | null {
  const oldLines = oldContent.split("\n");
  if (oldLines.length < 3) return null;

  const firstTrimmed = oldLines[0].trim();
  const lastTrimmed = oldLines[oldLines.length - 1].trim();
  const middleOld = oldLines.slice(1, -1).map((l) => l.trim());

  const originalLines = original.split("\n");
  const candidates: { start: number; end: number; sim: number }[] = [];

  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i].trim() !== firstTrimmed) continue;
    const windowEnd = Math.min(i + oldLines.length * 2, originalLines.length);
    for (let endIdx = i + oldLines.length - 1; endIdx < windowEnd; endIdx++) {
      if (endIdx >= originalLines.length) break;
      if (originalLines[endIdx].trim() !== lastTrimmed) continue;
      const middleOrig = originalLines.slice(i + 1, endIdx).map((l) => l.trim());

      let sim: number;
      if (middleOld.length === 0 && middleOrig.length === 0) {
        sim = 1.0;
      } else if (middleOld.length === 0 || middleOrig.length === 0) {
        continue;
      } else {
        sim = similarity(middleOld.join("\n"), middleOrig.join("\n"));
      }
      candidates.push({ start: i, end: endIdx, sim });
    }
  }

  if (candidates.length === 0) return null;

  // Threshold 0.3 for a single candidate, 0.5 when multiple exist.
  const threshold = candidates.length === 1 ? 0.3 : 0.5;
  let best = candidates[0];
  for (const c of candidates) if (c.sim > best.sim) best = c;
  if (best.sim < threshold) return null;

  const actual = originalLines.slice(best.start, best.end + 1).join("\n");
  return original.includes(actual) ? actual : null;
}

function levenshtein(a: string, b: string): number {
  if (a === "" || b === "") {
    return Math.max(a.length, b.length);
  }
  const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }
  return matrix[a.length][b.length];
}

// ---------------------------------------------------------------------------
// Tier 4 (anchored fuzzy): BlockAnchorLevenshtein — first/last lines anchor,
// interior scored by per-line Levenshtein similarity averaged across middle.
// ---------------------------------------------------------------------------

/** Per-line Levenshtein similarity: 1 - distance / maxLen. */
function lineSimilarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1.0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  const distance = levenshtein(a, b);
  return 1 - distance / maxLen;
}

/**
 * True when equal-length strings differ in at most one position
 * (substitution-only edit — no insertion/deletion possible).
 * Length mismatches always return false: substitutions cannot change length.
 */
export function oneSubstitution(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diffs = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i] && ++diffs > 1) return false;
  }
  return true;
}

/**
 * Minimum trimmed line length for a single substitution to count as provable
 * drift. Below this, one changed character is too large a fraction of the
 * line to prove intent (a 2-char line with 1 sub is half rewritten); at
 * >= 8 chars the implied Levenshtein similarity is >= 0.875 — a genuinely
 * negligible relative edit, consistent with the fuzzy tiers' 0.9-mean world.
 */
const PROVABLE_SUBSTITUTION_MIN_LEN = 8;

/**
 * Provable line pair: identical after trim, or differing by exactly one
 * substitution on a long-enough line (see PROVABLE_SUBSTITUTION_MIN_LEN).
 */
function isProvableLinePair(ta: string, tb: string): boolean {
  return (
    ta === tb ||
    (oneSubstitution(ta, tb) && Math.max(ta.length, tb.length) >= PROVABLE_SUBSTITUTION_MIN_LEN)
  );
}

/**
 * Per-line similarity with a PROVABLE fast tier ahead of the Levenshtein DP:
 * provable pairs score 1.0 outright.
 *
 * Monotone: verifiedLineSim(a,b) >= lineSimilarity(a,b) for all inputs, so
 * swapping it into a scorer only widens acceptance sets and makes selection
 * prefer provable readings — it can never invalidate a previously accepted
 * match. Every non-provable pair still goes through the same DP as before.
 */
export function verifiedLineSim(a: string, b: string): number {
  const ta = a.trim();
  const tb = b.trim();
  if (isProvableLinePair(ta, tb)) return 1.0;
  return lineSimilarity(ta, tb);
}

export function blockAnchorLevenshteinFind(original: string, oldContent: string): string | null {
  const oldLines = oldContent.split("\n");
  if (oldLines.length < 3) return null;

  const firstTrimmed = oldLines[0].trim();
  const lastTrimmed = oldLines[oldLines.length - 1].trim();
  const middleOld = oldLines.slice(1, -1).map((l) => l.trim());

  const originalLines = original.split("\n");
  const candidates: { start: number; end: number; sim: number }[] = [];

  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i].trim() !== firstTrimmed) continue;
    const windowEnd = Math.min(i + oldLines.length * 2, originalLines.length);
    for (let endIdx = i + oldLines.length - 1; endIdx < windowEnd; endIdx++) {
      if (originalLines[endIdx].trim() !== lastTrimmed) continue;
      const middleOrig = originalLines.slice(i + 1, endIdx).map((l) => l.trim());

      let sim: number;
      if (middleOld.length === 0 && middleOrig.length === 0) {
        sim = 1.0;
      } else if (middleOld.length === 0 || middleOrig.length === 0) {
        continue;
      } else if (middleOrig.length !== middleOld.length) {
        continue;
      } else {
        const linesToCheck = middleOld.length;
        let total = 0;
        for (let k = 0; k < linesToCheck; k++) {
          // Raw Levenshtein deliberately: the mean measures total drift.
          // Provability upgrades live in the boundary anchors, never here —
          // a single proven line must not carry a weak window over the gate.
          total += lineSimilarity(middleOld[k]!, middleOrig[k]!);
        }
        sim = total / linesToCheck;
      }
      candidates.push({ start: i, end: endIdx, sim });
    }
  }

  if (candidates.length === 0) return null;

  // Threshold 0.3 for a single candidate, 0.5 when multiple exist.
  const threshold = candidates.length === 1 ? 0.3 : 0.5;
  let best = candidates[0];
  for (const c of candidates) if (c.sim > best.sim) best = c;
  if (best.sim < threshold) return null;

  const actual = originalLines.slice(best.start, best.end + 1).join("\n");
  return original.includes(actual) ? actual : null;
}

// ---------------------------------------------------------------------------
// Tier 3 (exact-after-normalization): WhitespaceNormalized — collapse
// whitespace runs per line, then compare. Deterministic transform, not fuzzy.
// ---------------------------------------------------------------------------

function wsNormalize(s: string): string {
  return s
    .split("\n")
    .map((ln) => ln.replace(/\s+/g, " ").trim())
    .join("\n");
}

export function whitespaceNormalizedFind(original: string, oldContent: string): string | null {
  const normOld = wsNormalize(oldContent);
  const originalLines = original.split("\n");
  const oldLineCount = oldContent.split("\n").length;

  for (let i = 0; i < originalLines.length; i++) {
    const endMax = Math.min(i + oldLineCount + 2, originalLines.length);
    for (let j = i + oldLineCount - 1; j <= endMax; j++) {
      if (j > originalLines.length) break;
      const candidate = originalLines.slice(i, j).join("\n");
      if (wsNormalize(candidate) === normOld && original.includes(candidate)) return candidate;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tier 3 (exact-after-normalization): IndentationFlexible — ignore leading
// indentation and blank lines, then compare trimmed lines sequentially.
// ---------------------------------------------------------------------------

export function indentationFlexibleFind(original: string, oldContent: string): string | null {
  const oldStripped = oldContent
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (oldStripped.length === 0) return null;

  const originalLines = original.split("\n");

  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i].trim() !== oldStripped[0]) continue;
    const matchedIndices: number[] = [];
    let j = 0;
    const searchEnd = Math.min(i + oldStripped.length * 3, originalLines.length);
    for (let k = i; k < searchEnd; k++) {
      if (j >= oldStripped.length) break;
      const origLine = originalLines[k];
      if (origLine.trim().length === 0) continue;
      if (origLine.trim() === oldStripped[j]) {
        matchedIndices.push(k);
        j += 1;
      } else {
        break;
      }
    }

    if (j === oldStripped.length && matchedIndices.length > 0) {
      const start = matchedIndices[0];
      const end = matchedIndices[matchedIndices.length - 1] + 1;
      const actual = originalLines.slice(start, end).join("\n");
      if (original.includes(actual)) return actual;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tier 3 (exact-after-normalization): EscapeNormalized — unescape common
// sequences (\\n, \\t, \", …) before comparing. Fires only when unescaping
// changes the query.
// ---------------------------------------------------------------------------

function unescape(s: string): string {
  // Backslash sequences first so that literal `\n` becomes `\n` and is then
  // converted to a real newline by the `\n` rule below.
  return s
    .replaceAll("\\\\", "\\")
    .replaceAll("\\n", "\n")
    .replaceAll("\\t", "\t")
    .replaceAll("\\r", "\r")
    .replaceAll('\\"', '"')
    .replaceAll("\\'", "'")
    .replaceAll("\\`", "`")
    .replaceAll("\\$", "$");
}

export function escapeNormalizedFind(original: string, oldContent: string): string | null {
  const unescaped = unescape(oldContent);
  if (unescaped === oldContent) return null;
  return original.includes(unescaped) ? unescaped : null;
}

// ---------------------------------------------------------------------------
// Tier 5 (loose legacy scans): TrimmedBoundary — trim the whole block, then
// fall back to first/last-line contains-anchors. Low-precision last resort
// before reinforcement passes.
// ---------------------------------------------------------------------------

export function trimmedBoundaryFind(original: string, oldContent: string): string | null {
  const trimmed = oldContent.trim();
  if (trimmed === oldContent) return null;

  if (original.includes(trimmed)) return trimmed;

  // Line-level expansion: first/last content lines as contains-anchors.
  const oldLines = oldContent.split("\n");
  const firstContent = oldLines[0].trim();
  const lastContent = oldLines[oldLines.length - 1].trim();

  if (firstContent.length === 0 || lastContent.length === 0) return null;

  const originalLines = original.split("\n");
  for (let i = 0; i < originalLines.length; i++) {
    if (!originalLines[i].includes(firstContent)) continue;
    const end = Math.min(i + oldLines.length + 2, originalLines.length);
    for (let j = i + 1; j < end; j++) {
      if (j >= originalLines.length) break;
      if (!originalLines[j].includes(lastContent)) continue;
      const candidate = originalLines.slice(i, j + 1).join("\n");
      if (original.includes(candidate)) return candidate;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tier 5 (loose legacy scans): ContextAware — first/last non-empty lines as
// contains-anchors (LCS similarity > 0.5). Low-precision last resort.
// ---------------------------------------------------------------------------

export function contextAwareFind(original: string, oldContent: string): string | null {
  const oldLines = oldContent.split("\n");
  if (oldLines.length < 2) return null;

  const firstCtx = oldLines.find((l) => l.trim().length > 0)?.trim();
  const lastCtx = [...oldLines]
    .reverse()
    .find((l) => l.trim().length > 0)
    ?.trim();
  if (!firstCtx || !lastCtx) return null;

  const originalLines = original.split("\n");

  const starts: number[] = [];
  originalLines.forEach((l, i) => {
    if (l.trim().includes(firstCtx)) starts.push(i);
  });

  if (starts.length === 0) return null;

  let bestMatch: string | null = null;
  let bestSim = 0.0;

  for (const start of starts) {
    const searchEnd = Math.min(start + oldLines.length * 2, originalLines.length);
    for (let end = start + 1; end < searchEnd; end++) {
      if (originalLines[end].trim().includes(lastCtx)) {
        const candidate = originalLines.slice(start, end + 1).join("\n");
        // Bound prune: sim <= 2*min/(lenA+lenB); if even that cannot exceed
        // the strict 0.5 gate, the DP result cannot either — skip without
        // changing outcomes.
        if (similarityUpperBound(oldContent.trim(), candidate.trim()) > 0.5) {
          const sim = similarity(oldContent.trim(), candidate.trim());
          if (sim > bestSim && sim > 0.5) {
            bestSim = sim;
            bestMatch = candidate;
          }
        }
        break; // first end anchor per start only
      }
    }
  }

  return bestMatch !== null && original.includes(bestMatch) ? bestMatch : null;
}

// ---------------------------------------------------------------------------
// Tier 3 (exact-after-normalization): UnicodeNormalized — NFKC + punctuation
// map (typographic quotes/dashes). Deterministic transform; runs in Tier 3
// despite definition order here. Definition order ≠ chain order.
// ---------------------------------------------------------------------------
//
// NFKC handles NBSP→space and ligatures (ﬁ→fi), but NOT typographic quotes or
// dashes (no compatibility decomposition exists) — the PUNCT_MAP covers those.
// Matching-only: `actual` is always verbatim original text. Deterministic
// transform, so it runs in tier 3 before the anchored-fuzzy tier.

const PUNCT_MAP: Record<string, string> = {
  "\u2018": "'", // ‘ left single quote
  "\u2019": "'", // ’ right single quote
  "\u201A": "'", // ‚ single low-9 quote
  "\u201B": "'", // ‛ single high-reversed-9 quote
  "\u201C": '"', // “ left double quote
  "\u201D": '"', // ” right double quote
  "\u201E": '"', // „ double low-9 quote
  "\u201F": '"', // ‟ double high-reversed-9 quote
  "\u2013": "-", // – en dash
  "\u2014": "-", // — em dash
};

function normalizeText(s: string): string {
  return s
    .normalize("NFKC")
    .replace(
      /[\u2018\u2019\u201A\u201B\u201C\u201D\u201E\u201F\u2013\u2014]/g,
      (c) => PUNCT_MAP[c] ?? c,
    );
}

/** ASCII check — lets the common case skip normalization entirely. */
function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 127) return false;
  }
  return true;
}

/** Map an index in the normalized form of `s` back to an index in `s`. */
function mapNormalizedIndex(s: string, normIndex: number): number {
  let consumed = 0;
  for (let i = 0; i < s.length; i++) {
    const n = normalizeText(s[i]).length;
    if (consumed + n > normIndex) return i;
    consumed += n;
    if (consumed === normIndex) return i + 1;
  }
  return s.length;
}

export function unicodeNormalizedFind(original: string, oldContent: string): string | null {
  const normOld = normalizeText(oldContent);
  // Skip if the query is already normalized and the file is pure ASCII.
  // Non-ASCII files still run with a plain query: the file may hold ligatures.
  if (normOld === oldContent && isAscii(original)) return null;
  const normOrig = normalizeText(original);
  const idx = normOrig.indexOf(normOld);
  if (idx === -1) return null;
  const start = mapNormalizedIndex(original, idx);
  const end = mapNormalizedIndex(original, idx + normOld.length);
  const actual = original.slice(start, end);
  return original.includes(actual) ? actual : null;
}

// ---------------------------------------------------------------------------
// Tier 4 (anchored fuzzy): FuzzyBoundary — whole-block similarity with fuzzy
// boundary lines. Adjacent to BlockAnchor family in the chain (boundary-anchored,
// uniqueness-gated).
// ---------------------------------------------------------------------------

// Minimum mean per-line similarity for a window to qualify. Deliberately far
// above block_anchor_levenshtein's 0.3/0.5: here the BOUNDARY lines are also
// fuzzy, so only near-verbatim blocks may match.
const FUZZY_BOUNDARY_SIM = 0.9;
// At least one boundary line (first or last) must be this similar after trim,
// so the window is anchored to recognizable content instead of sliding.
const FUZZY_BOUNDARY_ANCHOR = 0.75;

/**
 * Pass: fuzzy_boundary.
 *
 * Observed in the wild (16 calls in old-era corpus, sims 0.90-1.00): models
 * paraphrase ONE line inside an otherwise verbatim block — e.g. inserting a
 * word into the first line ("across Pi tools" -> "across all Pi tools") or
 * writing the intended post-edit condition as SEARCH text. Every existing
 * pass refuses because block_anchor_levenshtein requires EXACT trimmed
 * first/last lines and the exact passes need verbatim content.
 *
 * Safety: candidate windows have exactly the query's line count, mean
 * per-line Levenshtein similarity >= 0.9, a >= 0.75-similar boundary anchor
 * line, and must be UNIQUE at that threshold. Uniqueness is judged across
 * all qualifying windows so a file with repeated similar blocks still fails.
 * Provability (exact-after-trim / long-line single substitution) applies to
 * the ANCHOR check only: it makes anchoring deterministic without letting a
 * single proven line carry an otherwise-weak window over the mean gate.
 */
export function fuzzyBoundaryFind(original: string, oldContent: string): string | null {
  const oldLines = oldContent.split("\n");
  if (oldLines.length < 3) return null;

  const originalLines = original.split("\n");
  if (originalLines.length < oldLines.length) return null;

  const firstOld = oldLines[0]!.trim();
  const lastOld = oldLines[oldLines.length - 1]!.trim();

  let best: { sim: number; start: number } | null = null;
  let qualifying = 0;
  const lastStart = originalLines.length - oldLines.length;

  /**
   * Similarity with a provable fast tier and an exactness-preserving floor
   * shortcut. Provable pairs score 1.0 with no DP; when the length-ratio
   * bound proves lev-sim < floor, returns 0 without the O(len^2) DP. Safe
   * here because callers only test max(a,b) >= floor: zeroing a pair proven
   * below the floor never flips that predicate, and provable pairs can only
   * raise it.
   */
  const lineSimilarityFloor = (a: string, b: string, floor: number): number => {
    if (a === b) return 1.0;
    const ta = a.trim();
    const tb = b.trim();
    if (isProvableLinePair(ta, tb)) return 1.0;
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1.0;
    if (1 - Math.abs(a.length - b.length) / maxLen < floor) return 0;
    return verifiedLineSim(ta, tb);
  };

  for (let start = 0; start <= lastStart; start++) {
    // Cheap prefilter BEFORE computing the full mean: one boundary line must
    // already look like its counterpart, otherwise skip the window.
    const firstSim = lineSimilarityFloor(
      originalLines[start]!.trim(),
      firstOld,
      FUZZY_BOUNDARY_ANCHOR,
    );
    const lastIdx = start + oldLines.length - 1;
    const lastSim = lineSimilarityFloor(
      originalLines[lastIdx]!.trim(),
      lastOld,
      FUZZY_BOUNDARY_ANCHOR,
    );
    if (Math.max(firstSim, lastSim) < FUZZY_BOUNDARY_ANCHOR) continue;

    let total = 0;
    let viable = true;
    for (let k = 0; k < oldLines.length; k++) {
      // Raw Levenshtein deliberately: the mean measures total drift, so a
      // single provable line must not carry a weak window over the gate.
      total += lineSimilarity(originalLines[start + k]!.trim(), oldLines[k]!.trim());
      // Exact early-abandon: remaining lines can add at most 1.0 each, so if
      // even a perfect rest cannot lift the mean to the threshold, this
      // window cannot qualify — stop paying for Levenshtein DPs on it.
      if ((total + (oldLines.length - k - 1)) / oldLines.length < FUZZY_BOUNDARY_SIM) {
        viable = false;
        break;
      }
    }
    if (!viable) continue;
    const sim = total / oldLines.length;
    if (sim < FUZZY_BOUNDARY_SIM) continue;
    qualifying++;
    if (!best || sim > best.sim) best = { sim, start };
  }

  // Unique at threshold: more than one qualifying window means the region is
  // not identifiable — leave it to ambiguity diagnostics instead of guessing.
  if (!best || qualifying !== 1) return null;

  const actual = originalLines.slice(best.start, best.start + oldLines.length).join("\n");
  return original.includes(actual) ? actual : null;
}

// ---------------------------------------------------------------------------
// Chain registry — single source of truth for pass order
// ---------------------------------------------------------------------------

export interface Replacer {
  name: string;
  find: PassFind;
  /**
   * True for passes too heuristic to participate in ANCHOR lookups. Anchors
   * are disambiguation aids: fuzz-finding them can silently re-anchor edits
   * to a wrong-but-similar region and defeats the redundant-anchor guard
   * (an anchor that only fuzz-matches is effectively equal to oldText).
   */
  searchOnly?: boolean;
}

/**
 * Chain order — 7 tiers from deterministic transforms to fuzzy rescue.
 *
 * The chain short-circuits on the first hit, so earlier passes SHADOW later
 * ones. Ordering principle: a pass may only run before another when its match
 * is a more precise reading of the model's intent. Tiers:
 *
 *   1. verbatim                   — simple
 *   2. per-line trim              — line_trimmed
 *   3. exact-after-normalization  — whitespace_normalized, indentation_flexible,
 *                                   escape_normalized, unicode_normalized
 *                                   (deterministic transforms: only fire on
 *                                   essentially exact-after-rewrite content)
 *   4. anchored fuzzy             — block_anchor, block_anchor_levenshtein,
 *                                   fuzzy_boundary (exact/strong boundaries,
 *                                   scored middle, uniqueness-gated for fuzzy_boundary)
 *   5. loose legacy scans         — trimmed_boundary, context_aware
 *   6. reinforcement              — robust_trimmed, robust_backslash (uniqueness-gated)
 *   7. token-multiset rescue      — token_overlap (Sørensen-Dice + Levenshtein floor,
 *                                   searchOnly — never participates in anchor lookups)
 *
 * Definition order in this file does NOT match chain order — the list above
 * and REPLACER_CHAIN below are the authoritative order.
 */

// ---------------------------------------------------------------------------
// Tier 7 (token-multiset rescue): TokenOverlap — Sørensen-Dice over token
// multisets + Levenshtein floor (mined: score-chain). Coarsest lens, last.
// ---------------------------------------------------------------------------
//
// For the residual class where content SURVIVES but line order does not:
// reordered lines, hallucinated middles, reformatted blocks (chimera recall,
// mined 2026-08-25 pool, 49 CANDIDATE failures). Every earlier pass needs
// some structural honesty (exact boundaries, trimmed boundaries); this pass
// instead asks "is the same STUFF in exactly one place?" — multiset token
// overlap — and then confirms the window is not a different region that
// happens to share vocabulary via a Levenshtein floor.
//
// Fail-closed on purpose:
//   - >=3 query lines (smaller edits belong to deterministic passes)
//   - dice >= TOKEN_DICE_MIN AND lev-similarity >= TOKEN_LEV_FLOOR
//   - EXACTLY ONE qualifying window, else null (ambiguity stays ambiguous)
// Runs LAST so it can never shadow a more precise reading.

/** Minimum Sørensen-Dice coefficient over token multisets to consider a window. */
export const TOKEN_DICE_MIN = 0.65;
/** Minimum LCS/Levenshtein-family similarity for a qualifying window. */
export const TOKEN_LEV_FLOOR = 0.45;
/** Queries shorter than this many lines are other passes' job. */
export const TOKEN_MIN_LINES = 3;

export function tokenOverlapFind(original: string, oldContent: string): string | null {
  const oldLines = oldContent.split("\n");
  if (oldLines.length < TOKEN_MIN_LINES) return null;

  const originalLines = original.split("\n");

  // Budget guard: window evaluations are O(tokens) each; refuse pathological
  // file x query shapes instead of feeding the not-found hotspot (issue #28).
  const minSize = Math.max(TOKEN_MIN_LINES, oldLines.length - 2);
  if ((originalLines.length - minSize + 1) * 5 > 400_000) return null;

  // Query multiset built ONCE. Window multisets are merged from per-line
  // maps; the window string is materialized only for qualifying candidates.
  const queryCounts = tokenCounts(oldContent);
  let queryTotal = 0;
  for (const v of queryCounts.values()) queryTotal += v;
  if (queryTotal === 0) return null;

  const lineMaps = originalLines.map((l) => tokenCounts(l));

  interface Qualifier {
    start: number;
    end: number;
    win: string;
    dice: number;
  }
  const qualifiers: Qualifier[] = [];

  // Window sizes M-2..M+2 cover off-by-a-line boundary drift.
  for (let size = minSize; size <= oldLines.length + 2; size++) {
    if (size > originalLines.length) break;

    // Sliding window over [start, start+size): multiset updated incrementally.
    const winCounts = new Map<string, number>();
    let winTotal = 0;
    for (let i = 0; i < size; i++) {
      for (const [t, c] of lineMaps[i]!) {
        winCounts.set(t, (winCounts.get(t) ?? 0) + c);
        winTotal += c;
      }
    }

    for (let start = 0; ; start++) {
      // Dice via current multiset.
      const inter = intersectSize(queryCounts, winCounts);
      const dice = winTotal === 0 ? 0 : (2 * inter) / (queryTotal + winTotal);
      if (dice >= TOKEN_DICE_MIN) {
        const win = originalLines.slice(start, start + size).join("\n");
        // Lev floor: shared vocabulary must also be shared ORDER-ish
        // structure, else "same words elsewhere" re-anchors the edit.
        if (
          similarityUpperBound(oldContent, win) > TOKEN_LEV_FLOOR &&
          similarity(oldContent, win) >= TOKEN_LEV_FLOOR
        ) {
          qualifiers.push({ start, end: start + size, win, dice });
        }
      }

      // Slide: drop line `start`, add line `start+size`.
      if (start + size >= originalLines.length) break;
      for (const [t, c] of lineMaps[start]!) {
        const nc = (winCounts.get(t) ?? 0) - c;
        if (nc <= 0) winCounts.delete(t);
        else winCounts.set(t, nc);
        winTotal -= c;
      }
      for (const [t, c] of lineMaps[start + size]!) {
        winCounts.set(t, (winCounts.get(t) ?? 0) + c);
        winTotal += c;
      }
    }
  }
  if (qualifiers.length === 0) return null;

  // Best window wins; overlapping qualifiers are the SAME region seen at
  // neighbor sizes, not ambiguity. A qualifier entirely elsewhere IS.
  let best = qualifiers[0]!;
  for (const q of qualifiers) {
    const betterDice = q.dice > best.dice;
    const closerSize =
      q.dice === best.dice &&
      Math.abs(q.end - q.start - oldLines.length) <
        Math.abs(best.end - best.start - oldLines.length);
    if (betterDice || closerSize) best = q;
  }
  for (const q of qualifiers) {
    if (q === best) continue;
    const overlaps = q.start < best.end && best.start < q.end;
    if (!overlaps) return null; // second distinct region -> ambiguous
  }
  return original.includes(best.win) ? best.win : null;
}

export const REPLACER_CHAIN: readonly Replacer[] = [
  { name: "simple", find: simpleFind },
  { name: "line_trimmed", find: lineTrimmedFind },
  { name: "whitespace_normalized", find: whitespaceNormalizedFind },
  { name: "indentation_flexible", find: indentationFlexibleFind },
  { name: "escape_normalized", find: escapeNormalizedFind },
  { name: "unicode_normalized", find: unicodeNormalizedFind },
  { name: "block_anchor", find: blockAnchorFind },
  { name: "block_anchor_levenshtein", find: blockAnchorLevenshteinFind },
  // Robust reinforcement passes moved below in pi-robust-edit parity; see
  // tail of chain. fuzzy_boundary stays adjacent to its block-anchor twins:
  // like them it is boundary-anchored (>=0.75) and refuses non-unique windows.
  { name: "fuzzy_boundary", find: fuzzyBoundaryFind, searchOnly: true },
  { name: "trimmed_boundary", find: trimmedBoundaryFind },
  { name: "context_aware", find: contextAwareFind },
  // Reinforcement passes (pi-robust-edit parity): run last so they only ever
  // observe failures of every structural pass above.
  { name: "robust_trimmed", find: robustTrimmedFind },
  { name: "robust_backslash", find: robustBackslashFind },
  // Token-multiset rescue (see tokenOverlapFind docs): coarsest lens, runs
  // dead last, searchOnly per the ANCHOR vs SEARCH scope law.
  { name: "token_overlap", find: tokenOverlapFind, searchOnly: true },
];
