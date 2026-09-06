/**
 * Raw-splice engine — byte-preserving reconstruction for untouched regions.
 *
 * Copied verbatim from decorated-pi/tools/patch/core.ts (lines 1071-1133).
 * The executor (pipeline/execute.ts) reads raw bytes, LF-normalizes for
 * matching, collects RawSplice[] from resolved edits, then calls
 * spliceOntoRaw to rebuild the file: edited spans get newStr, everything
 * else keeps its exact original bytes (CRLF, mixed endings, encoding).
 * buildNormToRawMap is the coordinate translator that makes the splices
 * (expressed in normalized offsets) land at the right raw offsets.
 */

// Single normalizeNewlines home is edit/text.ts — re-exported here so
// callers of raw-splice's normalizeLineEndings keep working (same function).

export { normalizeNewlines as normalizeLineEndings } from "../text.js";
import { normalizeNewlines as normalizeLineEndings } from "../text.js";

/** A replacement expressed in coordinates of the normalized (\n-only) content,
 *  paired with the exact new text to drop in. Used by spliceOntoRaw to rebuild
 *  the file byte-for-byte on the original rawContent. */
export interface RawSplice {
  /** Offset in the normalized content where the matched text starts. */
  normStart: number;
  /** Offset in the normalized content one past the matched text. */
  normEnd: number;
  /** Verbatim replacement text (already normalized to \n). */
  newStr: string;
}

/** Map every index of the normalized content to its offset in rawContent.
 *  The two strings differ only by `\r` bytes (CRLF→LF normalization removed
 *  them), so we walk both in lockstep. O(n). */
export function buildNormToRawMap(raw: string, norm: string): Int32Array {
  const map = new Int32Array(norm.length + 1);
  let ri = 0;
  for (let ni = 0; ni <= norm.length; ni++) {
    // Skip any `\r` in raw that the normalization folded into `\n`.
    // norm[ni] corresponds to raw[ri]; when norm advances past a `\n` that
    // came from `\r\n`, raw must skip the `\r` first.
    if (ni < norm.length) {
      map[ni] = ri;
      const ch = norm.charCodeAt(ni);
      const rawCh = raw.charCodeAt(ri);
      if (ch === 10 /* \n */ && rawCh === 13 /* \r */) {
        // Distinguish a folded CRLF pair (skip both bytes) from a lone \r
        // that normalizeNewlines also folds to \n (single byte — advancing
        // two here desynced every subsequent offset).
        if (raw.charCodeAt(ri + 1) === 10 /* \n */) {
          ri += 2;
        } else {
          ri += 1;
        }
      } else {
        ri += 1;
      }
    } else {
      map[ni] = raw.length;
    }
  }
  return map;
}

/** Rebuild the file on top of the original rawContent: untouched regions keep
 *  their original bytes (including CRLF / mixed endings), edited regions get
 *  the verbatim newStr the caller supplied. Splices must be sorted by
 *  normStart and non-overlapping. */
export function spliceOntoRaw(rawContent: string, splices: RawSplice[]): string {
  if (splices.length === 0) return rawContent;
  const norm = normalizeLineEndings(rawContent);
  const map = buildNormToRawMap(rawContent, norm);
  let out = "";
  let rawCursor = 0;
  for (const s of splices) {
    const rawStart = map[s.normStart] ?? 0;
    const rawEnd = map[s.normEnd] ?? rawContent.length;
    if (rawStart > rawCursor) out += rawContent.substring(rawCursor, rawStart);
    out += s.newStr;
    rawCursor = rawEnd;
  }
  if (rawCursor < rawContent.length) out += rawContent.substring(rawCursor);
  return out;
}

/** Build line offset table: offsets[i] = character offset of line i+1 (1-based).
 *  If the content does not end with a newline, the final line has no
 *  trailing marker; push an extra offset at content.length so callers
 *  like lineAtOffset handle the last line correctly. */
export function buildLineOffsets(content: string): number[] {
  const offsets = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") offsets.push(i + 1);
  }
  if (content.length > 0 && content[content.length - 1] !== "\n") {
    offsets.push(content.length);
  }
  return offsets;
}

/** Binary search: find 1-based line number containing charOffset. */
export function lineAtOffset(lineOffsets: number[], charOffset: number): number {
  let lo = 0;
  let hi = lineOffsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (lineOffsets[mid] <= charOffset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1; // 1-based
}

/** Binary search: find character offset at start of lineNum (1-based). */
export function offsetAtLine(lineOffsets: number[], lineNum: number): number {
  if (lineNum < 1) return 0;
  if (lineNum > lineOffsets.length) return lineOffsets[lineOffsets.length - 1] ?? 0;
  return lineOffsets[lineNum - 1] ?? 0;
}
