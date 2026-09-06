/**
 * Autopatch orchestration — three pre-resolution passes that fix common
 * model mistakes in `ParsedBlock[].oldText` (and `newText`) before the
 * fuzzy match chain runs. Mutates `blocks` in place. Called from
 * pipeline/execute.ts after LF-normalization and before resolveBlocks().
 *
 * Pass 0: escaped control chars (literal \\t/\\n → "\\t"/"\\n")
 * Pass 1: trailing whitespace (strip + trailing-empty-line alignment)
 * Pass 2: indentation mismatch (tabs↔spaces retarget + newText re-indent)
 *
 * Each pass is fail-closed: original must have 0 matches, corrected must
 * have exactly 1, and (Pass 2) the change must be indentation-only.
 */

import type { ParsedBlock } from "../../model.js";
import { computeTrailingWhitespaceOldTextPatch } from "./trailing-ws.js";
import { retargetReplacementIndentation } from "./indent-retarget.js";
import { countOccurrences } from "../../pipeline/resolve.js";
import { isIndentationOnlyChange } from "./indent.js";
import { tryCorrectIndentationMismatchFromContent } from "./indent.js";
import { telemetry } from "../../../telemetry.js";
import { normalizeNewlines } from "../../text.js";

// ---------------------------------------------------------------------------
// Pass 0 — escaped control characters
// ---------------------------------------------------------------------------

function pass0EscapedControlChars(blocks: ParsedBlock[], normContent: string): number[] {
  const patched: number[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    const v = block.oldText;
    // Only fire when the raw oldText contains literal tab/newline chars
    // (the JSON-decoded form), which means the model emitted the two-char
    // escape sequences \t/\n that were interpreted as actual control chars.
    if (!v.includes("\t") && !v.includes("\n")) continue;
    // Original must not already match.
    if (countOccurrences(normContent, v) !== 0) continue;
    // Escape back to the two-character sequences.
    const escaped = v.replace(/\t/g, "\\t").replace(/\n/g, "\\n");
    if (escaped === v) continue;
    // Escaped variant must match exactly once.
    if (countOccurrences(normContent, escaped) !== 1) continue;
    block.oldText = escaped;
    patched.push(i);
    telemetry.record({
      type: "edit.autopatch",
      timestamp: Date.now(),
      passName: "pass0_escaped_control_chars",
      index: i,
    });
  }
  return patched;
}

// ---------------------------------------------------------------------------
// Pass 1 — trailing whitespace
// ---------------------------------------------------------------------------

function pass1TrailingWhitespace(blocks: ParsedBlock[], normContent: string): number[] {
  const patched: number[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    const patch = computeTrailingWhitespaceOldTextPatch({
      oldText: block.oldText,
      newText: block.newText,
      fileContent: normContent,
    });
    if (!patch) continue;
    block.oldText = patch.oldText;
    if (patch.newText !== undefined) {
      block.newText = patch.newText;
    }
    patched.push(i);
    telemetry.record({
      type: "edit.autopatch",
      timestamp: Date.now(),
      passName: "pass1_trailing_whitespace",
      index: i,
    });
  }
  return patched;
}

// ---------------------------------------------------------------------------
// Pass 2 — indentation mismatch
// ---------------------------------------------------------------------------

function pass2IndentationMismatch(blocks: ParsedBlock[], normContent: string): number[] {
  const patched: number[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    const original = block.oldText;
    const corrected = tryCorrectIndentationMismatchFromContent(original, normContent);
    if (corrected === undefined) continue;
    // Safety gate: the change must be indentation-only.
    if (!isIndentationOnlyChange(original, corrected)) continue;
    // Original must not already match.
    if (countOccurrences(normContent, original) !== 0) continue;
    // Corrected must match exactly once.
    if (countOccurrences(normContent, corrected) !== 1) continue;
    block.oldText = corrected;
    // Retarget newText indentation to match the oldText correction.
    const retargeted = retargetReplacementIndentation(block.newText, original, corrected);
    if (retargeted !== undefined) {
      block.newText = retargeted;
    }
    patched.push(i);
    telemetry.record({
      type: "edit.autopatch",
      timestamp: Date.now(),
      passName: "pass2_indentation_mismatch",
      index: i,
    });
  }
  return patched;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run the three autopatch passes over `blocks` in place.
 *
 * Each pass only fires when its safety gates pass:
 *   - original oldText has 0 matches in `normContent`
 *   - corrected candidate has exactly 1 match
 *   - (Pass 2) change is indentation-only
 *
 * Falls through silently when gates fail — the resolver handles the original
 * text with standard oldtext_not_found / oldtext_duplicate reporting.
 */
export function autopatchBlocks(blocks: ParsedBlock[], normContent: string): void {
  const normalized = normalizeNewlines(normContent);
  pass0EscapedControlChars(blocks, normalized);
  pass1TrailingWhitespace(blocks, normalized);
  pass2IndentationMismatch(blocks, normalized);
}
