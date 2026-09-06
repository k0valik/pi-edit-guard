/**
 * Robust matching strategies — port of pi-robust-edit's 4-pass findInBuffer,
 * adapted to work on normalized strings within our existing replacer chain.
 *
 * These are "reinforcement" passes: they run AFTER the main replacer chain,
 * handling failure modes the deterministic and anchored passes don't cover:
 *
 *   - trimmed:  the file has trailing whitespace the model didn't include
 *   - backslash: JSON backslash-escape mismatches (\" ↔ ")
 *
 * Each pass returns the ACTUAL text from the original file, preserving
 * the safety invariant that matched text is always verbatim original.
 */

import { normalizeNewlines } from "../text.js";

// ---------------------------------------------------------------------------
// Pass A: trimmed — strip trailing whitespace from each file line
// ---------------------------------------------------------------------------

/**
 * Try matching against a version of `original` where each line's trailing
 * whitespace is stripped. Returns the verbatim matched text from the
 * original (including its trailing whitespace), or null if no unique match.
 */
export function robustTrimmedFind(original: string, oldContent: string): string | null {
  const orig = normalizeNewlines(original);
  const old = normalizeNewlines(oldContent);

  // Fast path: exact match — let simpleFind handle it
  if (orig.includes(old)) return null;

  // Build a trimmed version of the original file (strip trailing ws from each line)
  const trimmedOrig = orig
    .split("\n")
    .map((line: string) => line.trimEnd())
    .join("\n");

  // If trimming didn't change anything, no point continuing
  if (trimmedOrig === orig) return null;

  // Try matching the trimmed query against the trimmed file
  const trimmedQuery = old.trimEnd();
  const idx = trimmedOrig.indexOf(trimmedQuery);
  if (idx === -1) return null;

  // Check uniqueness in the trimmed version
  const secondIdx = trimmedOrig.indexOf(trimmedQuery, idx + 1);
  if (secondIdx !== -1) return null; // ambiguous

  // Walk the original buffer to find the start position of the match
  let origPos = 0;
  let trimPos = 0;
  while (trimPos < idx && origPos < orig.length) {
    const ch = orig[origPos];
    if (ch === "\r") {
      origPos++;
      continue;
    }
    if ((ch === " " || ch === "\t") && isTrailingWhitespace(orig, origPos)) {
      origPos++;
      continue;
    }
    if (trimmedOrig[trimPos] === ch) {
      trimPos++;
    }
    origPos++;
  }

  // Extract actual bytes from original, absorbing trailing whitespace per line
  // (ported from pi-robust-edit's extractActualBytesAtPosition)
  const trimmedLines = trimmedQuery.split("\n");
  let bytePos = origPos;
  const extractedChunks: string[] = [];

  for (let li = 0; li < trimmedLines.length; li++) {
    const targetLine = trimmedLines[li] ?? "";
    let matched = 0;
    const lineStart = bytePos;

    // Match characters of this line
    while (matched < targetLine.length && bytePos < orig.length) {
      const byte = orig[bytePos];
      if (byte === undefined) break;
      const ch = orig[bytePos];
      if (ch === "\n" || ch === "\r") break;
      if (ch === targetLine[matched]) {
        matched++;
        bytePos++;
      } else if (ch === " " || ch === "\t") {
        bytePos++; // skip trailing whitespace in original
      } else {
        return null; // non-matching, non-whitespace char — bad match
      }
    }

    if (matched < targetLine.length) return null; // incomplete match

    // Absorb trailing whitespace before the newline
    while (bytePos < orig.length) {
      const ch = orig[bytePos];
      if (ch === "\n") {
        bytePos++; // consume \n
        break;
      }
      if (ch === "\r") {
        bytePos++;
        if (bytePos < orig.length && orig[bytePos] === "\n") bytePos++; // consume \r\n
        break;
      }
      if (ch === " " || ch === "\t") {
        bytePos++; // absorb trailing whitespace
      } else {
        break; // unexpected char
      }
    }

    extractedChunks.push(orig.slice(lineStart, bytePos));
  }

  const actual = extractedChunks.join("");
  // Verify uniqueness in the original buffer
  const firstIdx = orig.indexOf(actual);
  const origSecondIdx = orig.indexOf(actual, firstIdx + 1);
  if (origSecondIdx !== -1) return null; // ambiguous in original

  return orig.includes(actual) ? actual : null;
}

function isTrailingWhitespace(s: string, pos: number): boolean {
  for (let i = pos; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\n" || ch === "\r") return true;
    if (ch !== " " && ch !== "\t") return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Pass B: backslash-escape — bidirectional JSON escape normalization
// ---------------------------------------------------------------------------

/**
 * Try matching with backslash-escape variants:
 *   1. Add backslashes before bare double-quotes (model forgot to escape)
 *   2. Strip backslashes before double-quotes (model over-escaped)
 *
 * Returns the verbatim matched text from original, or null if no unique match.
 */
export function robustBackslashFind(original: string, oldContent: string): string | null {
  const orig = normalizeNewlines(original);
  const old = normalizeNewlines(oldContent);

  // Variant 1: add backslash before bare double-quotes
  const backslashAdded = old.replace(/(?<!\\)"/g, '\\"');
  if (backslashAdded !== old) {
    const positions = findAllOccurrences(orig, backslashAdded);
    if (positions.length === 1) {
      return orig.includes(backslashAdded) ? backslashAdded : null;
    }
  }

  // Variant 2: strip backslash before double-quotes
  const backslashStripped = old.replace(/\\"/g, '"');
  if (backslashStripped !== old && backslashStripped !== backslashAdded) {
    const positions = findAllOccurrences(orig, backslashStripped);
    if (positions.length === 1) {
      return orig.includes(backslashStripped) ? backslashStripped : null;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Byte-level helpers (adapted from pi-robust-edit/src/core.ts)
// ---------------------------------------------------------------------------

/** Find all occurrences of needle in haystack. Returns character offsets
 *  (JavaScript string indices, i.e. UTF-16 code unit positions). */
export function findAllOccurrences(haystack: string, needle: string): number[] {
  const positions: number[] = [];
  let searchPos = 0;
  while (searchPos <= haystack.length) {
    const idx = haystack.indexOf(needle, searchPos);
    if (idx === -1) break;
    positions.push(idx);
    searchPos = idx + 1;
  }
  return positions;
}
