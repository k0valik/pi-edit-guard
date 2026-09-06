/**
 * Indentation-mismatch autopatch for oldText.
 *
 * Ported from pi-lens `clients/read-guard-tool-lines.ts` (lines ~789–890):
 *   - `tryCorrectIndentationMismatchFromContent` — the core corrector
 *   - `findIndentationInsensitiveCandidate` — direct helper (Tier 0)
 *   - `isIndentationOnlyChange` — safety gate
 *
 * NOT ported: Tier A/B/C fallback candidates
 * (`findBlankLineInsensitiveCandidate`, `findWhitespaceInsensitiveCandidate`,
 * `findUnicodePunctuationInsensitiveCandidate`) — our fuzzy chain covers
 * those cases.
 *
 * Source: tmp-repos/pi-lens/clients/read-guard-tool-lines.ts
 */

/**
 * Tries to fix a tab/space indentation mismatch between the model's oldText and the
 * actual file. Returns the corrected oldText if a matching variant is found, or
 * undefined if the text already matches or no indentation conversion fixes it.
 */
export function tryCorrectIndentationMismatchFromContent(
  oldText: string,
  content: string,
): string | undefined {
  const normalized = oldText.replace(/\r\n/g, "\n");
  if (content.includes(normalized)) return undefined;

  const conversions = [
    // tabs → 2 spaces
    (s: string) =>
      s
        .split("\n")
        .map((l) => l.replace(/^\t+/, (m) => "  ".repeat(m.length)))
        .join("\n"),
    // tabs → 4 spaces
    (s: string) =>
      s
        .split("\n")
        .map((l) => l.replace(/^\t+/, (m) => "    ".repeat(m.length)))
        .join("\n"),
    // 2 spaces → tabs
    (s: string) =>
      s
        .split("\n")
        .map((l) => l.replace(/^( {2})+/, (m) => "\t".repeat(m.length / 2)))
        .join("\n"),
    // 4 spaces → tabs
    (s: string) =>
      s
        .split("\n")
        .map((l) => l.replace(/^( {4})+/, (m) => "\t".repeat(m.length / 4)))
        .join("\n"),
  ];

  for (const convert of conversions) {
    const candidate = convert(normalized);
    if (candidate !== normalized && content.includes(candidate)) return candidate;
  }

  const indentationInsensitiveCandidate = findIndentationInsensitiveCandidate(content, normalized);
  if (indentationInsensitiveCandidate !== undefined) {
    return indentationInsensitiveCandidate;
  }

  return undefined;
}

function findIndentationInsensitiveCandidate(content: string, oldText: string): string | undefined {
  const contentLines = content.split("\n");
  const oldLines = oldText.split("\n");
  const stripIndent = (line: string) => line.replace(/^[\t ]+/, "").trimEnd();
  const expected = oldLines.map(stripIndent);

  for (let start = 0; start <= contentLines.length - oldLines.length; start += 1) {
    let matches = true;
    for (let offset = 0; offset < oldLines.length; offset += 1) {
      if (stripIndent(contentLines[start + offset] ?? "") !== expected[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      const candidate = contentLines.slice(start, start + oldLines.length).join("\n");
      if (candidate !== oldText) return candidate;
    }
  }

  return undefined;
}

/**
 * Returns true when `after` differs from `before` in indentation only —
 * same number of lines, each line's trimmed content is identical.
 */
export function isIndentationOnlyChange(before: string, after: string): boolean {
  const beforeLines = before.replace(/\r\n/g, "\n").split("\n");
  const afterLines = after.replace(/\r\n/g, "\n").split("\n");
  if (beforeLines.length !== afterLines.length) return false;
  return beforeLines.every((line, index) => line.trim() === afterLines[index].trim());
}
