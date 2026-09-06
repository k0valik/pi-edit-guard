// Closest-candidate-on-failure: when the chain finds nothing, return the
// nearest near-miss so the model corrects against real file content.
// Anchor on lines similar to the query's first line (floor-gated), then score
// bounded windows from each anchor. The floor — not the passes' thresholds —
// is the only gate: "nearest candidate, even below threshold."

import { similarity, similarityUpperBound, tokenDice, tokenJaccard } from "./similarity.js";
import type { ClosestCandidate } from "../model.js";
import { normalizeNewlines } from "../text.js";

/** Minimum line-level similarity for a line to be considered an anchor. */
const ANCHOR_FLOOR = 0.3;

/**
 * Hard cap on total Levenshtein DP cells spent scoring windows. The naive
 * walk (anchors x window lengths, full DP each) is quadratic in file x query
 * size and produced multi-minute not-found diagnostics on real sessions
 * (pool entry #773: 995s). Beyond the budget the best-so-far candidate wins
 * — diagnostics degrade gracefully instead of hanging the tool.
 */
const DP_CELL_BUDGET = 50_000_000;

export function findClosestCandidate(
  original: string,
  oldContent: string,
  maxCandidates = 50,
): ClosestCandidate | null {
  const orig = normalizeNewlines(original);
  const old = normalizeNewlines(oldContent).trim();
  if (old.length === 0) return null;

  const oldLines = old.split("\n");
  const firstLine = oldLines[0].trim();
  if (firstLine.length === 0) return null;

  const origLines = orig.split("\n");

  // Anchor lines — lines similar enough to the query's first line.
  const anchors: { start: number; sim: number }[] = [];
  for (let i = 0; i < origLines.length && anchors.length < maxCandidates; i++) {
    // Bound prune: if even the length-ratio bound cannot reach the floor,
    // the LCS DP result cannot either — skip without changing outcomes.
    if (similarityUpperBound(origLines[i].trim(), firstLine) < ANCHOR_FLOOR) continue;
    const lineSim = similarity(origLines[i].trim(), firstLine);
    if (lineSim >= ANCHOR_FLOOR) anchors.push({ start: i, sim: lineSim });
  }

  if (anchors.length === 0) return null;

  // Collect all windows with their O(1) length-ratio upper bound first, then
  // score DPs in DESCENDING bound order. The first DP fixes a strong best;
  // every later window whose bound cannot strictly beat it is skipped, and
  // because the list is sorted, the first such window ends the scan. Same
  // result as the naive order, astronomically fewer DPs.
  interface Window {
    start: number;
    end: number;
    bound: number;
    text: string;
  }
  const windows: Window[] = [];
  for (const { start } of anchors) {
    const minEnd = start + oldLines.length - 1;
    const maxEnd = Math.min(start + oldLines.length * 2, origLines.length);
    for (let end = minEnd; end < maxEnd; end++) {
      const text = origLines
        .slice(start, end + 1)
        .join("\n")
        .trim();
      windows.push({ start, end, bound: similarityUpperBound(old, text), text });
    }
  }
  windows.sort((a, b) => b.bound - a.bound);

  let best: { start: number; end: number; sim: number } | null = null;
  let cellsSpent = 0;
  for (const w of windows) {
    // Sorted descent: nothing later can beat the current best.
    if (best && w.bound <= best.sim) break;
    // Budget guard: estimated DP cells (rows x cols of the lev matrix).
    const cost = old.length * w.text.length;
    if (cellsSpent + cost > DP_CELL_BUDGET) continue;
    const sim = similarity(old, w.text);
    cellsSpent += cost;
    if (!best || sim > best.sim) best = { start: w.start, end: w.end, sim };
  }

  if (!best) return null;

  const actual = origLines.slice(best.start, best.end + 1).join("\n");
  return {
    passName: "closest-candidate",
    similarity: best.sim,
    candidate: actual,
    startLine: best.start + 1,
    endLine: best.end + 1,
    tokenDice: tokenDice(old, actual.trim()),
    tokenJaccard: tokenJaccard(old, actual.trim()),
  };
}
