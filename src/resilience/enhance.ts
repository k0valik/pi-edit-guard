/**
 * Error text normalization and enhancement — pure, no Pi imports.
 *
 * Ported from pi-deepseek-optimized's utils.ts, stripped of model gating
 * (matchesModelPattern) and hashline annotation (lineHash/annotateLine).
 * Provides: errorSignature() (path/line/hex-normalized dedup key for
 * stormbreaker) and enhanceError() (actionable rewrites for no-such-file,
 * permission, oldText-not-found, offset-OOB — otherwise passthrough).
 */

/**
 * Normalize an error message into a signature for consecutive-failure dedup.
 *
 * Strips file-specific details (paths, line numbers, timestamps) so that
 * "Error: open /foo/bar.txt: no such file" and "Error: open /baz/qux.txt: no such file"
 * are considered the same failure class.
 */
/**
 * Signature length cap. Sized to match extractErrorText's 500-char input cap
 * so the signature layer adds no ADDITIONAL loss beyond what extraction
 * already applies — distinct errors that share a long boilerplate header
 * must not collapse into one loop-break signature merely because the cap
 * bit before their distinguishing tail.
 */
export const SIGNATURE_MAX_CHARS = 500;

export function errorSignature(toolName: string, errorText: string): string {
  const normalized = errorText
    .replace(/\/[^\s:]+/g, "<path>") // file paths
    .replace(/line \d+/gi, "line N") // line numbers
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g, "<timestamp>") // ISO timestamps
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>") // hex addresses
    .slice(0, SIGNATURE_MAX_CHARS);
  return `${toolName}:${normalized}`;
}

/**
 * Extract the error message from a tool result's content array.
 *
 * Tool results contain `(TextContent | ImageContent)[]`. We concatenate
 * all text content to produce an error signature for storm-breaker dedup.
 */
export function extractErrorText(
  content: { type: string; text?: string; data?: string }[],
): string {
  return content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text!)
    .join("\n")
    .slice(0, 500); // cap for dedup signature
}

/**
 * Enhance a raw tool error message to be more actionable.
 *
 * Catches common unhelpful error patterns and replaces them with messages
 * that tell the model *what to fix*, not just *what broke*.
 */
export function enhanceError(toolName: string, errorText: string): string {
  // No-such-file errors
  if (/open.*?no such file/is.test(errorText) || /no such file or directory/i.test(errorText)) {
    // Empty-path evidence must be ANCHORED to a path-bearing context — a bare
    // '""' anywhere in the message (e.g. an oldText that resolved to empty)
    // used to misroute unrelated failures into "your path argument is empty".
    if (
      /open\s*:?\s*['"]{2}/.test(errorText) ||
      /['"]path["']\s*:\s*['"]{2}/.test(errorText) ||
      /open\s+''/.test(errorText)
    ) {
      return `Error: the 'path' argument is empty or missing. Please provide a valid file path.`;
    }
    return `${errorText}\n\nThe file does not exist. Check the path and try read or ls to locate it.`;
  }

  // Permission errors
  if (/permission denied/i.test(errorText)) {
    return `${errorText}\n\nThis usually means the file is not readable. Check the path and permissions.`;
  }

  // Edit tool partial-match errors — include the actual content for context.
  // Only match edit-specific patterns to avoid catching unrelated 'not found' errors.
  if (
    /old_text.*not found|old_string.*not found|did not match|exact string.*not found/i.test(
      errorText,
    )
  ) {
    return `${errorText}\n\nThe exact string was not found in the file. This commonly happens when:\n- The file was modified since you last read it (re-read the file)\n- Whitespace differs (tabs vs spaces, trailing whitespace)\n- You are matching content from an outdated read\nSuggestion: use read to get fresh content, then retry.`;
  }

  // Offset out of bounds
  if (/offset.*beyond end of file/i.test(errorText)) {
    return `${errorText}\nThe file may be shorter than expected. Use read without offset to see the full file.`;
  }

  // Default: pass through with tool name context
  return `[${toolName}] ${errorText}`;
}
