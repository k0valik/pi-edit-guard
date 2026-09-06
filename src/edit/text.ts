/**
 * Text utilities for the edit domain — BOM handling, line-ending detection
 * and normalization. Single home for newline normalization so the matching
 * chain (chain.ts / passes.ts), executor (pipeline/execute.ts) and raw-splice
 * engine agree on what "normalized" means. Every file read is stripped of
 * its BOM and normalized to LF before matching; restoreLineEndings re-applies
 * the detected style on the way out.
 */

/**
 * Minimum length (after newline normalization) for REPLACE text or a matched
 * span to count as evidence that an edit was "already applied". Shorter
 * strings are too trivial — they appear incidentally in most files.
 */
export const ALREADY_APPLIED_MIN_CHARS = 16;

/** Normalize CRLF and lone CR to LF (OpenDev parity: normalize_line_endings). */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Detect the dominant line ending of a file: '\n', '\r\n', or '\r'. */
export function detectLineEnding(content: string): "\n" | "\r\n" | "\r" {
  const crlf = content.indexOf("\r\n");
  const lf = content.indexOf("\n");
  const cr = content.indexOf("\r");
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return "\r\n";
  if (cr !== -1) return "\r";
  return "\n";
}

/** Restore the original line ending style onto LF-normalized text. */
export function restoreLineEndings(text: string, ending: "\n" | "\r\n" | "\r"): string {
  if (ending === "\r\n") return text.replace(/\n/g, "\r\n");
  if (ending === "\r") return text.replace(/\n/g, "\r");
  return text;
}

/** Strip a UTF-8 BOM if present; returns the BOM and the remaining text. */
export function stripBom(content: string): { bom: string; text: string } {
  if (content.charCodeAt(0) === 0xfeff) {
    return { bom: content.slice(0, 1), text: content.slice(1) };
  }
  return { bom: "", text: content };
}
