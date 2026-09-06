/**
 * Resolution phase — per-file orchestration: anchor window → findMatch
 * (chain.ts) → disproportionate guard → uniqueness (reportOccurrences) →
 * auto-expand → closest-candidate (on failure) → diagnostics.
 *
 * Historical shape note — why two layers, not one incremental loop:
 * - resolveBlocks is the two-pass entry point. Pass 1 resolves every block
 *   against the ORIGINAL content (non-incremental — all blocks see the same
 *   snapshot). This prevents earlier edits silently shifting later matches.
 *   Pass 2 only retries blocks that failed as `not-found` / `anchor-not-found`
 *   against the post-Pass-1 content to handle shift-induced misses (e.g. line
 *   numbers drifted because Pass 1 inserted lines). Do NOT make Pass 1
 *   incremental — that re-introduces the overlapping-shift misfire class.
 * - doResolvePass is the single-pass resolver (anchor scoping,
 *   redundant-anchor dropping, fallback-to-full-content, replaceAll, and
 *   already-applied detection all live there). Failures become EditError with
 *   structured kind + near-miss alternatives for the tool layer.
 */

import { applyEdits } from "./apply.js";
import { findClosestCandidate } from "../matching/closest.js";
import { findMatch } from "../matching/chain.js";
import {
  alreadyAppliedError,
  ambiguousError,
  anchorAmbiguousError,
  anchorNotFoundError,
  disproportionateError,
  noOpError,
  notFoundError,
  overlappingError,
  validationError,
} from "../errors.js";
import { reportOccurrences } from "./uniqueness.js";
import {
  buildAmbiguousAlternatives,
  buildNearMissAlternatives,
  findAllExactSpans,
} from "../matching/candidates.js";
import {
  buildLineOffsets,
  lineAtOffset,
  offsetAtLine,
  type RawSplice,
} from "../patching/raw-splice.js";
import { ALREADY_APPLIED_MIN_CHARS, normalizeNewlines } from "../text.js";
import { similarity } from "../matching/similarity.js";
import { telemetry } from "../../telemetry.js";
import type {
  AppliedEdit,
  EditDiagnostic,
  EditError,
  FailedEdit,
  MatchResult,
  ParsedBlock,
  ResolvedEdit,
} from "../model.js";

/** Auto-expand cap: total lines added around a match (half above, half below). */
const MAX_EXPAND_LINES = 10;

/**
 * Anchor ≈ oldText similarity at or above which a failed anchor is treated as
 * redundant (observed in the wild: model copies oldText into anchor and adds
 * hallucinated details like regex `/i` flags — the anchor can never match, but
 * the underlying edit is fine). Dropping the anchor falls back to normal
 * full-content matching with its uniqueness checks.
 */
const REDUNDANT_ANCHOR_SIMILARITY = 0.9;

/** Beyond this length, multiple occurrences still indicate the applied state. */
const ALREADY_APPLIED_STRONG_CHARS = 64;

export interface ResolveBlocksResult {
  ok: boolean;
  resolved: ResolvedEdit[];
  errors: EditError[];
  diagnostics: EditDiagnostic[];
  pass1Resolved?: ResolvedEdit[];
  pass2Resolved?: ResolvedEdit[];
}

/**
 * Resolve all blocks against one content string with two-pass incremental
 * fallback: Pass 1 resolves against the original content; Pass 2 re-resolves
 * blocks that failed with `missing` against the post-Pass1-application content.
 * Collects all errors instead of short-circuiting on the first one.
 */
export function resolveBlocks(
  content: string,
  blocks: ParsedBlock[],
  path: string,
): ResolveBlocksResult {
  const pass1 = doResolvePass(content, blocks, path);

  // Only attempt Pass 2 if some blocks resolved and some failed with
  // `not-found` / `anchor-not-found` (shift-induced misses).
  const missingErrors = pass1.errors.filter(
    (e) => e.kind === "not-found" || e.kind === "anchor-not-found",
  );
  if (missingErrors.length === 0 || pass1.resolved.length === 0) {
    return pass1;
  }

  // Identify which original block indices failed.
  const missingIndices = new Set<number>();
  for (const error of missingErrors) {
    if (error.index !== undefined) missingIndices.add(error.index);
  }
  // Also scan diagnostics for missing status.
  for (const diag of pass1.diagnostics) {
    if (diag.status === "missing") missingIndices.add(diag.index);
  }
  if (missingIndices.size === 0) return pass1;

  // Apply Pass 1 edits to get post-Pass1 content, then re-resolve.
  const pass1Result = applyEdits(content, pass1.resolved);
  const missingEntries: { block: ParsedBlock; originalIndex: number }[] = [];
  for (let i = 0; i < blocks.length; i++) {
    if (missingIndices.has(i)) missingEntries.push({ block: blocks[i]!, originalIndex: i });
  }
  if (missingEntries.length === 0) return pass1;

  const pass2 = doResolvePass(
    pass1Result.content,
    missingEntries.map((e) => e.block),
    path,
  );
  if (pass2.resolved.length === 0 && pass2.errors.length > 0) {
    // Pass 2 didn't recover anything — keep Pass 1 results.
    return pass1;
  }

  // Remap Pass 2 diagnostics/errors back to original block indices.
  const indexMap = new Map<number, number>();
  missingEntries.forEach((entry, i) => indexMap.set(i, entry.originalIndex));

  const remappedDiagnostics = pass2.diagnostics.map((d) => ({
    ...d,
    index: indexMap.get(d.index) ?? d.index,
  }));

  const remappedErrors = pass2.errors.map((e) => {
    if (e.index === undefined) return e;
    const originalIdx = indexMap.get(e.index);
    if (originalIdx === undefined) return e;
    return {
      ...e,
      index: originalIdx,
      message: e.message.replace(new RegExp(`edits\\[${e.index}\\]`, "g"), `edits[${originalIdx}]`),
    };
  });

  // Remove Pass 1 entries for blocks that Pass 2 successfully resolved.
  const pass2ResolvedOriginalIndices = new Set(
    remappedDiagnostics.filter((d) => d.status === "applied").map((d) => d.index),
  );
  const filteredPass1Diagnostics = pass1.diagnostics.filter(
    (d) => !pass2ResolvedOriginalIndices.has(d.index),
  );
  const filteredPass1Errors = pass1.errors.filter((e) => {
    if (e.index === undefined) return true;
    return !pass2ResolvedOriginalIndices.has(e.index);
  });

  return {
    ok: pass1.ok || pass2.ok,
    resolved: [...pass1.resolved, ...pass2.resolved],
    pass1Resolved: pass1.resolved,
    pass2Resolved: pass2.resolved,
    errors: [...filteredPass1Errors, ...remappedErrors],
    diagnostics: [...filteredPass1Diagnostics, ...remappedDiagnostics],
  };
}

/** Single-pass resolution against one content string (used by Pass 1 and Pass 2). */
function doResolvePass(content: string, blocks: ParsedBlock[], path: string): ResolveBlocksResult {
  const resolved: ResolvedEdit[] = [];
  const diagnostics: EditDiagnostic[] = [];
  const errors: EditError[] = [];

  // Offset table is content-dependent only — build once per pass, not per
  // block (O(file) each; on multi-edit calls the per-block rebuild dominated
  // resolve time).
  const lineOffsets = buildLineOffsets(content);
  const totalLines = Math.max(1, lineOffsets.length - 1);

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    const diag: EditDiagnostic = {
      index: i,
      oldText: block.oldText,
      newText: block.newText,
      status: "applied",
    };

    if (block.oldText.length === 0) {
      diag.status = "validation";
      diagnostics.push(diag);
      errors.push({
        ...validationError(`edits[${i}]: oldText is empty; provide the exact code to find.`),
        index: i,
      });
      continue;
    }
    if (normalizeNewlines(block.oldText) === normalizeNewlines(block.newText)) {
      diag.status = "noop";
      diagnostics.push(diag);
      errors.push({
        ...validationError(
          `edits[${i}]: oldText and newText are identical; this edit does nothing.`,
        ),
        index: i,
      });
      continue;
    }

    // Anchor window: when an anchor is provided and NOT redundant
    // (similarity to oldText < 0.9), locate it with the same findMatch chain,
    // then search for oldText ONLY within the anchor's line span ± MAX_EXPAND_LINES.
    // A near-duplicate anchor is treated as redundant and skipped entirely, so
    // oldText is matched against the full content instead.
    let searchContent = content;
    let baseOffset = 0;
    let winStartLine = 1;
    let anchorUsed = false;

    // One probe serves both the redundant-anchor check and the window path —
    // previously findMatch ran twice for every anchored block.
    const hasAnchor = !!(block.anchor && block.anchor.length > 0);
    const anchorProbe = hasAnchor
      ? findMatch(content, block.anchor!, { allowSearchOnly: false })
      : null;

    // Redundant-anchor drop: if the anchor matches nowhere but is nearly
    // identical to oldText, it adds no disambiguation value — skip the
    // window entirely and match oldText against the full content.
    const redundantAnchor =
      hasAnchor &&
      !anchorProbe &&
      similarity(block.anchor!.trim(), block.oldText.trim()) >= REDUNDANT_ANCHOR_SIMILARITY;

    if (hasAnchor && redundantAnchor) {
      diag.anchorRedundant = true;
      telemetry.record({
        type: "anchor.redundant_dropped",
        timestamp: Date.now(),
        path,
        similarity: Number(similarity(block.anchor!.trim(), block.oldText.trim()).toFixed(3)),
      });
    }

    if (hasAnchor && !redundantAnchor) {
      // Anchor lookups EXCLUDE search-only heuristic passes: a fuzz-found
      // anchor could re-anchor the edit to the wrong-but-similar region.
      const anchorMatch = anchorProbe;

      if (anchorMatch) {
        const anchorReport = reportOccurrences(content, anchorMatch.actual);
        if (anchorReport.ambiguous) {
          diag.status = "ambiguous";
          diag.alternatives = buildAmbiguousAlternatives(content, anchorMatch.actual);
          diagnostics.push(diag);
          telemetry.record({
            type: "anchor.ambiguous",
            timestamp: Date.now(),
            path,
            occurrences: anchorReport.count,
          });
          errors.push({
            ...anchorAmbiguousError(path, anchorReport.count, anchorReport.positions),
            index: i,
          });
          continue;
        }

        const anchorWindow = computeAnchorWindow(
          content,
          anchorMatch.actual,
          lineOffsets,
          totalLines,
        );
        if (!anchorWindow) {
          diag.status = "missing";
          diagnostics.push(diag);
          errors.push({
            ...validationError("internal invariant violated: matched anchor not found in content"),
            index: i,
          });
          continue;
        }
        searchContent = anchorWindow.searchContent;
        baseOffset = anchorWindow.baseOffset;
        winStartLine = anchorWindow.winStartLine;
        anchorUsed = true;
      } else {
        // Primary anchor not found — try fallback with closest candidates
        // (similarity > 0.7) before giving up.
        diag.status = "missing";
        const nearMisses = buildNearMissAlternatives(content, block.anchor!);
        diag.alternatives = nearMisses;
        telemetry.record({
          type: "anchor.not_found",
          timestamp: Date.now(),
          path,
        });

        let fallbackUsed = false;

        for (const candidate of nearMisses) {
          if (candidate.similarity <= 0.7) break;
          const fallbackAnchorMatch = findMatch(content, candidate.candidate, {
            allowSearchOnly: false,
          });
          if (!fallbackAnchorMatch) continue;

          const fallbackAnchorReport = reportOccurrences(content, fallbackAnchorMatch.actual);
          if (fallbackAnchorReport.ambiguous) continue;

          const anchorWindow = computeAnchorWindow(
            content,
            fallbackAnchorMatch.actual,
            lineOffsets,
            totalLines,
          );
          if (!anchorWindow) continue;

          searchContent = anchorWindow.searchContent;
          baseOffset = anchorWindow.baseOffset;
          winStartLine = anchorWindow.winStartLine;
          anchorUsed = true;
          fallbackUsed = true;
          diag.status = "applied";
          diag.anchorFallback = true;
          diag.fallbackCandidate = candidate;
          break;
        }

        if (!fallbackUsed) {
          // Anchor resolves nowhere and no near-miss fallback fired. Mined
          // from live sessions (2026-08): models sometimes send anchors that
          // exist only in their imagination (a test title, a renamed symbol)
          // while oldText itself matches the file verbatim. Aborting here
          // wastes a correct edit — degrade to unanchored matching instead.
          // Fail-closed as ever: full-content uniqueness still enforced.
          const unanchored = findMatch(content, block.oldText);
          const unanchoredReport = unanchored
            ? reportOccurrences(content, unanchored.actual)
            : null;
          if (unanchored && !unanchoredReport!.ambiguous) {
            diag.status = "applied";
            diag.anchorFallback = true;
            resolved.push({
              edit: { path, oldText: block.oldText, newText: block.newText },
              match: unanchored,
              start: content.indexOf(unanchored.actual),
              end: content.indexOf(unanchored.actual) + unanchored.actual.length,
              blockIndex: i,
            });
            telemetry.record({
              type: "match.pass",
              timestamp: Date.now(),
              passName: "anchor_not_found_full_retry",
              autoExpand: false,
              anchorUsed: false,
            });
            diagnostics.push(diag);
            continue;
          }
          diagnostics.push(diag);
          const closest = findClosestCandidate(content, block.anchor!);
          errors.push({ ...anchorNotFoundError(path, closest ?? undefined), index: i });
          continue;
        }
      }
    }

    const match = findMatch(searchContent, block.oldText);
    if (!match && anchorUsed) {
      // Windowed search failed but an anchor scoped it. Mined from live
      // sessions (2026-08): models use anchors as IDENTIFICATION, not
      // scoping — the anchor may sit 30 lines away from a verbatim-unique
      // target, or a near-miss fallback may have anchored misleadingly.
      // Degrade to unanchored matching: run the full chain against the whole
      // file. Every downstream guard (uniqueness, disproportionate,
      // auto-expand) then operates at full scope exactly as if no anchor had
      // been given; multiple full-content occurrences still fail as
      // ambiguous, so this stays fail-closed.
      const startsWithAnchor = block.oldText.startsWith(block.anchor || "");
      const fullMatch = findMatch(content, block.oldText);
      if (fullMatch) {
        // Unique at full scope: the anchor failed to help, the text itself
        // is unambiguous — apply. Ambiguous at full scope: the anchor could
        // never have disambiguated it; report honestly instead of guessing.
        const fullReport = reportOccurrences(content, fullMatch.actual);
        if (!fullReport.ambiguous) {
          diag.anchorFallback = true;
          diag.anchorWindowOverflow = true;
          resolved.push({
            edit: { path, oldText: block.oldText, newText: block.newText },
            match: fullMatch,
            start: content.indexOf(fullMatch.actual),
            end: content.indexOf(fullMatch.actual) + fullMatch.actual.length,
            blockIndex: i,
          });
          telemetry.record({
            type: "match.pass",
            timestamp: Date.now(),
            passName: startsWithAnchor
              ? "anchor_window_overflow_fallback"
              : "anchor_window_miss_full_retry",
            autoExpand: false,
            anchorUsed: true,
          });
          diagnostics.push(diag);
          continue;
        }
        diag.status = "ambiguous";
        diag.alternatives = buildAmbiguousAlternatives(content, fullMatch.actual);
        diagnostics.push(diag);
        errors.push({ ...ambiguousError(path, fullReport.count, fullReport.positions), index: i });
        continue;
      }
    }

    if (!match) {
      diag.status = "missing";
      // Already-applied detection: REPLACE text present verbatim while SEARCH
      // is gone means the target state exists — report that instead of a
      // generic not-found (observed in the wild after partial retries).
      // False-positive guard: a SHORT replacement that appears MULTIPLE times
      // may just be common content (a comment, a boilerplate line) rather
      // than proof the edit was applied — require either a unique occurrence
      // or a long enough replacement to make coincidence implausible.
      const normalizedNew = normalizeNewlines(block.newText);
      // Length gate FIRST: countOccurrences with an empty needle never
      // advances its scan position (deletion edits have newText === "").
      const plausibleLength = normalizedNew.length >= ALREADY_APPLIED_MIN_CHARS;
      const newOccurrences = plausibleLength ? countOccurrences(content, normalizedNew) : 0;
      const plausibleAlreadyApplied =
        plausibleLength &&
        (newOccurrences === 1 || normalizedNew.length >= ALREADY_APPLIED_STRONG_CHARS);
      if (plausibleAlreadyApplied && newOccurrences > 0) {
        // Evidence, not verdict: cite WHERE the REPLACE text lives so the
        // model can falsify the claim (natural occurrences in unrelated
        // sites poisoned two models in the mined misfire corpus).
        const replacePositions = findAllExactSpans(content, normalizedNew).map(
          (span) => span.startLine,
        );
        diagnostics.push(diag);
        telemetry.record({
          type: "match.already_applied",
          timestamp: Date.now(),
          path,
        });
        errors.push({
          ...alreadyAppliedError(path, { count: newOccurrences, positions: replacePositions }),
          index: i,
        });
        continue;
      }
      diag.alternatives = buildNearMissAlternatives(searchContent, block.oldText);
      diagnostics.push(diag);
      const closest = findClosestCandidate(searchContent, block.oldText);
      // Map window-relative candidate lines back to file-absolute lines.
      if (closest && anchorUsed) {
        closest.startLine += winStartLine - 1;
        closest.endLine += winStartLine - 1;
      }
      if (closest) {
        telemetry.record({
          type: "match.closest_candidate",
          timestamp: Date.now(),
          similarity: closest.similarity,
          lineRange: { start: closest.startLine, end: closest.endLine },
        });
      }
      errors.push({
        ...notFoundError(
          path,
          closest ?? undefined,
          block.anchor
            ? "Anchor status: search was anchor-scoped — retry with corrected text or remove the anchor."
            : "Anchor status: none provided — supply unique nearby context to narrow the search.",
        ),
        index: i,
      });
      continue;
    }

    if (isDisproportionateMatch(match.actual, block.oldText)) {
      diag.status = "missing";
      diagnostics.push(diag);
      errors.push({ ...disproportionateError(path), index: i });
      continue;
    }

    // ---------------------------------------------------------------------
    // replaceAll: replace EVERY occurrence of the matched text in the file.
    // Skips the ambiguity check and auto-expand. Each span is individually
    // guarded against disproportionate fuzzy matches.
    // ---------------------------------------------------------------------
    if (block.replaceAll) {
      const spans = findAllSpans(content, match.actual);
      let disproportionate = false;
      for (const span of spans) {
        const actual = content.slice(span.start, span.end);
        if (isDisproportionateMatch(actual, block.oldText)) {
          disproportionate = true;
          break;
        }
      }
      if (disproportionate) {
        diag.status = "missing";
        diagnostics.push(diag);
        errors.push({ ...disproportionateError(path), index: i });
        continue;
      }
      const passName = spans.length > 1 ? "replace_all" : match.passName;
      for (const span of spans) {
        resolved.push({
          edit: { path, oldText: block.oldText, newText: block.newText },
          match: { ...match, passName },
          start: span.start,
          end: span.end,
        });
      }
      telemetry.record({
        type: "match.pass",
        timestamp: Date.now(),
        passName,
        autoExpand: false,
        anchorUsed,
      });
      if (spans.length > 0) {
        const firstSpan = spans[0]!;
        diag.match = {
          start: firstSpan.start,
          end: firstSpan.end,
          passName,
          anchorUsed,
        };
        diag.lineRange = {
          start: lineAtOffset(lineOffsets, firstSpan.start),
          end: lineAtOffset(lineOffsets, firstSpan.end - 1),
        };
      }
      diagnostics.push(diag);
      continue;
    }

    const report = reportOccurrences(searchContent, match.actual);
    if (report.ambiguous) {
      const expanded = tryAutoExpand(searchContent, block, path, match.actual, baseOffset, i);
      if (expanded) {
        resolved.push(expanded);
        telemetry.record({
          type: "match.pass",
          timestamp: Date.now(),
          passName: "auto_expand",
          autoExpand: true,
          anchorUsed,
        });
        diag.match = {
          start: expanded.start,
          end: expanded.end,
          passName: expanded.match.passName,
          anchorUsed,
        };
        diagnostics.push(diag);
        continue;
      }
      diag.status = "ambiguous";
      diag.alternatives = buildAmbiguousAlternatives(searchContent, match.actual);
      diagnostics.push(diag);
      const positions = anchorUsed
        ? report.positions.map((p) => p + winStartLine - 1)
        : report.positions;
      errors.push({ ...ambiguousError(path, report.count, positions), index: i });
      continue;
    }

    const localStart = searchContent.indexOf(match.actual);
    if (localStart === -1) {
      diag.status = "missing";
      diagnostics.push(diag);
      errors.push({
        ...validationError("internal invariant violated: matched text not found in content"),
        index: i,
      });
      continue;
    }

    const start = baseOffset + localStart;
    resolved.push({
      edit: { path, oldText: block.oldText, newText: block.newText },
      match,
      start,
      end: start + match.actual.length,
      blockIndex: i,
    });
    telemetry.record({
      type: "match.pass",
      timestamp: Date.now(),
      passName: match.passName,
      autoExpand: false,
      anchorUsed,
    });
    diag.match = {
      start,
      end: start + match.actual.length,
      passName: match.passName,
      anchorUsed,
    };
    diag.lineRange = {
      start: lineAtOffset(lineOffsets, start),
      end: lineAtOffset(lineOffsets, start + match.actual.length - 1),
    };
    diagnostics.push(diag);
  }

  return {
    ok: resolved.length > 0,
    resolved,
    errors,
    diagnostics: diagnostics.length > 0 ? diagnostics : [],
  };
}

/** Resolve an anchor text against content, returning the window for oldText search.
 *  Returns null if the anchor is not found or is ambiguous. */
function computeAnchorWindow(
  content: string,
  anchorActual: string,
  lineOffsets: ReturnType<typeof buildLineOffsets>,
  totalLines: number,
): { searchContent: string; baseOffset: number; winStartLine: number } | null {
  const anchorStart = content.indexOf(anchorActual);
  if (anchorStart === -1) return null;
  const anchorEnd = anchorStart + anchorActual.length;
  const anchorStartLine = lineAtOffset(lineOffsets, anchorStart);
  const anchorEndLine = lineAtOffset(lineOffsets, anchorEnd - 1);
  const winStartLine = Math.max(1, anchorStartLine - MAX_EXPAND_LINES);
  const winEndLine = Math.min(totalLines, anchorEndLine + MAX_EXPAND_LINES);
  const winStart = offsetAtLine(lineOffsets, winStartLine);
  const winEnd =
    winEndLine < totalLines ? offsetAtLine(lineOffsets, winEndLine + 1) : content.length;
  return { searchContent: content.slice(winStart, winEnd), baseOffset: winStart, winStartLine };
}

export function failureToError(f: FailedEdit): EditError {
  switch (f.kind) {
    case "overlap":
      return overlappingError(f.reason);
    case "no-op":
      return f.reason.startsWith("already applied")
        ? alreadyAppliedError(f.edit.path)
        : noOpError();
    case "invariant":
      return validationError(f.reason);
    case "already-handled":
      return overlappingError(f.reason);
  }
}

/** Build sorted RawSplice[] from applied edits for a single pass. */
export function buildPassSplices(applied: AppliedEdit[]): RawSplice[] {
  return applied
    .map((a) => ({ normStart: a.start, normEnd: a.end, newStr: a.edit.newText }))
    .sort((a, b) => a.normStart - b.normStart);
}

// ---------------------------------------------------------------------------
// Auto-expand disambiguation
//
// When SEARCH matches multiple locations, grow context symmetrically around
// every occurrence until exactly ONE is unique. The replacement applies to the
// ORIGINAL span — expansion only locates. Multiple simultaneously-unique
// occurrences are genuinely indistinguishable → ambiguous error.
// ---------------------------------------------------------------------------

function tryAutoExpand(
  content: string,
  block: ParsedBlock,
  path: string,
  actual: string,
  baseOffset = 0,
  blockIndex?: number,
): ResolvedEdit | null {
  const spans = findAllSpans(content, actual);
  if (spans.length < 2) return null;

  const lines = content.split("\n");
  const lineRanges = spans.map((s) => ({
    startLine: lineIndexAt(lines, s.start),
    endLine: lineIndexAt(lines, s.end - 1),
  }));

  let above = 0;
  let below = 0;
  const half = Math.floor(MAX_EXPAND_LINES / 2);
  const maxLevel = MAX_EXPAND_LINES;

  for (let level = 0; level < maxLevel; level++) {
    // Expand alternately: above, below, above, below…
    if (level % 2 === 0) {
      if (above >= half) continue;
      above++;
    } else {
      if (below >= half) continue;
      below++;
    }

    const expandedBlocks = lineRanges.map(({ startLine, endLine }) => {
      const s = Math.max(0, startLine - above);
      const e = Math.min(lines.length, endLine + 1 + below);
      return lines.slice(s, e).join("\n");
    });

    const uniqueIdx = findSingleUnique(expandedBlocks, content);
    if (uniqueIdx !== null) {
      const span = spans[uniqueIdx];
      return {
        edit: { path, oldText: block.oldText, newText: block.newText },
        match: { actual, passName: "auto_expand" } satisfies MatchResult,
        start: span.start + baseOffset,
        end: span.end + baseOffset,
        blockIndex,
      };
    }
    // If MULTIPLE candidates are already unique, further expansion keeps them
    // unique forever (a unique block stays unique under extension) — bail.
    if (expandedBlocks.filter((b) => countOccurrences(content, b) === 1).length > 1) return null;
  }
  return null;
}

export function findAllSpans(content: string, needle: string): { start: number; end: number }[] {
  // Empty needle: indexOf always matches at `from` and the scan position
  // never advances — hard-guard instead of looping forever (parity with
  // countOccurrences; this OOM-killed a vitest worker when unguarded).
  if (needle.length === 0) return [];
  const spans: { start: number; end: number }[] = [];
  let from = 0;
  while (from <= content.length) {
    const idx = content.indexOf(needle, from);
    if (idx === -1) break;
    spans.push({ start: idx, end: idx + needle.length });
    from = idx + needle.length;
  }
  return spans;
}

export function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let from = 0;
  // Empty needle: indexOf always matches at `from` and the scan position
  // never advances — hard-guard instead of looping forever.
  if (needle.length === 0) return 0;
  while (from <= content.length) {
    const idx = content.indexOf(needle, from);
    if (idx === -1) break;
    count++;
    from = idx + needle.length;
  }
  return count;
}

/** Non-overlapping text replacement, mirroring the engine's span discovery. */

export function replace(
  content: string,
  oldText: string,
  newText: string,
  replaceAll = false,
): string {
  if (!replaceAll) {
    const idx = content.indexOf(oldText);
    if (idx === -1) return content;
    return content.slice(0, idx) + newText + content.slice(idx + oldText.length);
  }

  const spans = findAllSpans(content, oldText);
  if (spans.length === 0) return content;

  let result = "";
  let lastEnd = 0;
  for (const span of spans) {
    result += content.slice(lastEnd, span.start) + newText;
    lastEnd = span.end;
  }
  result += content.slice(lastEnd);
  return result;
}

/** Index of the line containing char `offset` in `lines` (joined by \n). */
function lineIndexAt(lines: string[], offset: number): number {
  let remaining = offset;
  for (let i = 0; i < lines.length; i++) {
    const len = lines[i].length + (i < lines.length - 1 ? 1 : 0);
    if (remaining < len) return i;
    remaining -= len;
  }
  return lines.length - 1;
}

/** Index of the candidate whose expanded block occurs exactly once, or null. */
function findSingleUnique(blocks: string[], content: string): number | null {
  let uniqueIdx: number | null = null;
  for (let i = 0; i < blocks.length; i++) {
    if (countOccurrences(content, blocks[i]) === 1) {
      if (uniqueIdx !== null) return null; // more than one unique → ambiguous
      uniqueIdx = i;
    }
  }
  return uniqueIdx;
}

/**
 * Refuse fuzzy matches spanning far more than the query — wrong-edit near-miss (OpenCode port).
 *
 * Rules (checked in order — the line guard runs FIRST):
 * - If the matched span has at least max(oldLines + 3, oldLines * 2) lines,
 *   refuse. This applies to single-line queries too: a one-line query that
 *   "matched" a 4+ line span is a misplaced boundary, not a real hit.
 * - For multi-line queries: if trimmed matched text length exceeds
 *   max(trimmed query length + 500, trimmed query length * 4), refuse.
 */
function isDisproportionateMatch(search: string, oldText: string): boolean {
  const oldLines = oldText.split("\n").length;
  const searchLines = search.split("\n").length;
  if (searchLines >= Math.max(oldLines + 3, oldLines * 2)) return true;
  if (oldLines === 1) return false;
  return search.trim().length > Math.max(oldText.trim().length + 500, oldText.trim().length * 4);
}
