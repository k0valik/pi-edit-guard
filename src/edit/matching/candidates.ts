/**
 * Candidate discovery and preview building for diagnostics — near-miss and
 * ambiguous alternatives shown in tool errors.
 *
 * Ported concepts from identedit's failed_diff/resolve.rs (KMP-based
 * overlapping sequences + candidate previews), adapted to string-based
 * matching. Used by pipeline/resolve.ts: findAllExactSpans / buildCandidatePreview
 * for ambiguous (multiple exact hits), findNearMisses / buildNearMissAlternatives
 * for not-found (similarity-ranked windows, bound-pruned and DP-budgeted).
 */

import { similarity, similarityUpperBound } from "./similarity.js";
import { buildLineOffsets, lineAtOffset, offsetAtLine } from "../patching/raw-splice.js";
import { normalizeNewlines } from "../text.js";
import type { CandidatePreview } from "../model.js";

// Re-export so consumers can import CandidatePreview from this module.
export type { CandidatePreview } from "../model.js";

// ============================================================================
// Types
// ============================================================================

export interface CandidateSpan {
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  similarity: number;
}

export interface NearMissCandidate {
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  candidate: string;
  similarity: number;
}

// ============================================================================
// Exact-occurrence finding
// ============================================================================

/**
 * Find ALL exact occurrences of `needle` in `haystack`, including line
 * numbers. Uses naive overlapping scan — sufficient for our typical
 * edit sizes and avoids the complexity of KMP for string (vs line-array)
 * matching.
 */
export function findAllExactSpans(haystack: string, needle: string): CandidateSpan[] {
  if (needle.length === 0) return [];
  const spans: CandidateSpan[] = [];
  const lineOffsets = buildLineOffsets(haystack);
  let from = 0;

  while (from <= haystack.length) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    // end is one-past-last-char; subtract 1 so lineAtOffset returns the
    // line that actually contains the last matched character.
    const end = idx + needle.length;
    const startLine = lineAtOffset(lineOffsets, idx);
    const endLine = lineAtOffset(lineOffsets, end - 1);
    spans.push({
      start: idx,
      end,
      startLine,
      endLine,
      similarity: 1.0,
    });
    from = idx + 1;
  }

  return spans;
}

// ============================================================================
// Preview building (ported from identedit's build_candidate_preview)
// ============================================================================

const DEFAULT_CONTEXT_LINES = 2;
const DEFAULT_MAX_MATCHED_LINES = 4;

/**
 * Build a before/matched/after preview around a matched span.
 *
 * Mirrors identedit's `build_candidate_preview`:
 *   - `before`: up to 2 context lines before the match
 *   - `matched`: up to 4 matched lines (with omitted count if truncated)
 *   - `after`: up to 2 context lines after the match
 */
export function buildCandidatePreview(
  content: string,
  start: number,
  end: number,
  contextLines = DEFAULT_CONTEXT_LINES,
  maxMatchedLines = DEFAULT_MAX_MATCHED_LINES,
): CandidatePreview {
  const lines = content.split("\n");
  const lineOffsets = buildLineOffsets(content);
  const startLine = lineAtOffset(lineOffsets, start);
  const endLine = lineAtOffset(lineOffsets, end - 1);

  const beforeStart = Math.max(0, startLine - 1 - contextLines);
  const afterEnd = Math.min(lines.length, endLine + contextLines);
  const matchedEnd = Math.min(endLine, startLine - 1 + maxMatchedLines);

  const slice = (from: number, to: number) =>
    lines.slice(from, to).map((text, i) => ({
      line: from + i + 1,
      content: text,
    }));

  return {
    before: slice(beforeStart, startLine - 1),
    matched: slice(startLine - 1, matchedEnd),
    matchedLinesOmitted: Math.max(0, endLine - matchedEnd),
    after: slice(endLine, afterEnd),
  };
}

// ============================================================================
// Near-miss finding (extends closest.ts with multi-candidate support)
// ============================================================================

/**
 * Find up to `maxCandidates` near-miss windows for `oldText` in `content`.
 *
 * Algorithm (mirrors identedit's anchor-then-window approach):
 *   1. Use the query's first line as an anchor (similarity floor 0.3)
 *   2. For each anchor line, score windows from `queryLength` to `2x queryLength`
 *   3. Return top N by similarity
 *
 * This is more useful than a single best-match when the model needs to
 * choose between several near-misses.
 */
export function findNearMisses(
  content: string,
  oldText: string,
  maxCandidates = 5,
): NearMissCandidate[] {
  const orig = normalizeNewlines(content);
  const old = normalizeNewlines(oldText).trim();
  if (old.length === 0) return [];

  const oldLines = old.split("\n");
  const firstLine = oldLines[0].trim();
  if (firstLine.length === 0) return [];

  const origLines = orig.split("\n");
  const lineOffsets = buildLineOffsets(orig);
  const candidates: NearMissCandidate[] = [];
  const seen = new Set<string>();

  // Anchor lines
  const anchors: number[] = [];
  for (let i = 0; i < origLines.length && anchors.length < maxCandidates * 3; i++) {
    const lineSim = similarity(origLines[i].trim(), firstLine);
    if (lineSim >= 0.3) anchors.push(i);
  }

  // Collect windows with their O(1) length-ratio upper bound, then run the
  // full DPs in DESCENDING bound order. The absolute 0.2 floor prunes almost
  // nothing here (windows are size-matched to the query by construction), so
  // the naive walk degenerated into anchors x lengths full DPs — multi-minute
  // not-found diagnostics on real sessions. Sorted descent + a running
  // top-K threshold skips every window that cannot make the cut; the DP
  // budget bounds pathological shapes. Same candidate set, minus tail noise.
  const NEAR_MISS_DP_CELL_BUDGET = 30_000_000;
  interface Window {
    start: number;
    end: number;
    bound: number;
    text: string;
  }
  const windows: Window[] = [];
  for (const start of anchors) {
    const minEnd = start + oldLines.length - 1;
    const maxEnd = Math.min(start + oldLines.length * 2, origLines.length);
    for (let end = minEnd; end <= maxEnd; end++) {
      const text = origLines
        .slice(start, end + 1)
        .join("\n")
        .trim();
      windows.push({ start, end, bound: similarityUpperBound(old, text), text });
    }
  }
  windows.sort((a, b) => b.bound - a.bound);

  let cellsSpent = 0;
  let threshold = -Infinity;
  for (const w of windows) {
    if (w.bound < 0.2 || w.bound <= threshold) break;
    const cost = old.length * w.text.length;
    if (cellsSpent + cost > NEAR_MISS_DP_CELL_BUDGET) continue;
    const sim = similarity(old, w.text);
    cellsSpent += cost;
    if (sim < 0.2) continue; // too far off

    const key = `${w.start}:${w.end}:${sim.toFixed(2)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // start+1 and end+2 are 1-based line numbers for offsetAtLine.
    // end+2 is the line AFTER the window; its offset is one-past-last-char.
    const startOffset = offsetAtLine(lineOffsets, w.start + 1);
    const endOffset = offsetAtLine(lineOffsets, w.end + 2);

    candidates.push({
      start: startOffset,
      end: endOffset,
      startLine: w.start + 1,
      endLine: w.end + 1,
      candidate: w.text,
      similarity: sim,
    });

    if (candidates.length >= maxCandidates) {
      threshold = Math.min(...candidates.map((c) => c.similarity));
    }
  }

  candidates.sort((a, b) => b.similarity - a.similarity);
  return candidates.slice(0, maxCandidates);
}

// ============================================================================
// Diagnostic helpers (used by resolve.ts)
// ============================================================================

import type { NearMissAlternative } from "../model.js";

/**
 * Build near-miss alternatives for a not-found edit.
 */
export function buildNearMissAlternatives(
  content: string,
  oldText: string,
  maxCandidates = 5,
): NearMissAlternative[] {
  const misses = findNearMisses(content, oldText, maxCandidates);
  const seen = new Set<string>();
  const unique: NearMissAlternative[] = [];
  for (const m of misses) {
    if (seen.has(m.candidate)) continue;
    seen.add(m.candidate);
    unique.push({
      start: m.start,
      end: m.end,
      startLine: m.startLine,
      endLine: m.endLine,
      candidate: m.candidate,
      similarity: m.similarity,
      preview: buildCandidatePreview(content, m.start, m.end),
    });
    if (unique.length >= maxCandidates) break;
  }
  return unique;
}

/**
 * Build candidate alternatives for an ambiguous exact-match.
 */
export function buildAmbiguousAlternatives(content: string, actual: string): NearMissAlternative[] {
  const spans = findAllExactSpans(content, actual);
  return spans.map((s) => ({
    start: s.start,
    end: s.end,
    startLine: s.startLine,
    endLine: s.endLine,
    candidate: actual,
    similarity: s.similarity,
    preview: buildCandidatePreview(content, s.start, s.end),
  }));
}
