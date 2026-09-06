/**
 * Coherence verification — non-blocking structural warnings on post-edit
 * content (brace/paren/bracket balance + indentation jumps). Called from
 * pipeline/execute.ts after raw-splice; results are surfaced in the tool
 * result text, details.guard.coherenceWarnings, and telemetry. Brace-balance
 * is currently disabled (BRACE_BALANCE_ENABLED = false) pending false-positive
 * tuning; indentation checks are brace-depth-aware so entering/exiting
 * nested blocks does not produce spurious jump warnings. Focus-windowed to
 * lines near applied edits when focusLines is provided.
 */

/**
 * TEMPORARY: brace/paren/bracket balance warnings are disabled until the
 * false-positive patterns are fixed (planned tuning branch — the fixture
 * tests below skip on this flag). Flip to `true` to restore the checker
 * without rewriting any of the logic in coherenceCheck().
 */
export const BRACE_BALANCE_ENABLED: boolean = false;

export function coherenceCheck(content: string, path?: string, focusLines?: Set<number>): string[] {
  const warnings: string[] = [];
  const lines = content.split("\n");

  if (BRACE_BALANCE_ENABLED) {
    // Brace/paren/bracket balance — suppress false positives for known
    // non-code files (shell scripts, regex files) and for content where
    // braces are predominantly inside template literals or regex literals.
    const ext = path ? path.split(".").pop()?.toLowerCase() : undefined;
    const suppressedExts = ["sh", "bash", "zsh", "fish", "regex", "regexp"];
    const suppressBraceBalance = ext ? suppressedExts.includes(ext) : false;

    if (!suppressBraceBalance) {
      let balance = 0;
      let inStr = false;
      let strCh = "";
      let esc = false;
      let inSL = false;
      let inML = false;
      for (let i = 0; i < content.length; i++) {
        const ch = content[i]!;
        if (inSL) {
          if (ch === "\n") inSL = false;
          continue;
        }
        if (inML) {
          if (ch === "*" && content[i + 1] === "/") {
            inML = false;
            i++;
          }
          continue;
        }
        if (inStr) {
          if (esc) {
            esc = false;
          } else if (ch === "\\") {
            esc = true;
            continue;
          } else if (ch === strCh) {
            inStr = false;
          }
          continue;
        }
        if (ch === '"' || ch === "'") {
          inStr = true;
          strCh = ch;
          continue;
        }
        if (ch === "/" && content[i + 1] === "/") {
          inSL = true;
          i++;
          continue;
        }
        if (ch === "/" && content[i + 1] === "*") {
          inML = true;
          i++;
          continue;
        }
        if (ch === "{" || ch === "(" || ch === "[") balance++;
        if (ch === "}" || ch === ")" || ch === "]") balance--;
      }

      if (balance !== 0) {
        const analysis = computeSpecialConstructBraceDensity(content);
        const hasStructuralImbalance = analysis.outsideBalance !== 0;
        const mostlySpecialConstruct = analysis.density >= 0.5;
        const unclosedSpecial = analysis.unclosedSpecial;

        if (!hasStructuralImbalance && !mostlySpecialConstruct) {
          // No real structural imbalance outside special constructs and
          // most braces are not inside special constructs — do not warn.
        } else if (hasStructuralImbalance && !mostlySpecialConstruct) {
          warnings.push(
            balance > 0
              ? `Unclosed ${balance} brace(s)/paren(s)/bracket(s).`
              : `Too many closing braces/parens/brackets (excess: ${-balance}).`,
          );
        } else if (unclosedSpecial) {
          // An unclosed template literal or regex literal likely means the
          // imbalance is real — do not suppress.
          warnings.push(
            balance > 0
              ? `Unclosed ${balance} brace(s)/paren(s)/bracket(s).`
              : `Too many closing braces/parens/brackets (excess: ${-balance}).`,
          );
        }
        // Otherwise suppress: most braces live inside special constructs and
        // there is no unclosed construct — likely a false positive.
      }
    }
  }

  // Indentation consistency: flag drastic jumps (>8 spaces) between
  // lines at the same brace depth. When `focusLines` is provided, only
  // lines within a window of a changed line are checked — this avoids
  // reporting unrelated historic jumps elsewhere in the file.
  const FOCUS_WINDOW = 6;
  const depths: number[] = Array.from({ length: lines.length }, () => 0);
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    depths[i] = depth;
    for (const ch of lines[i] ?? "") {
      if (ch === "{" || ch === "(" || ch === "[") depth++;
      if (ch === "}" || ch === ")" || ch === "]") depth--;
    }
  }

  const stringLines = computeStringLiteralLines(content);

  for (let i = 1; i < lines.length; i++) {
    const indent = lines[i].search(/\S/);
    if (indent < 0) continue; // blank line

    // Skip lines whose leading non-whitespace content lives inside a
    // string literal. Their indentation is string content, not code.
    if (stringLines.has(i)) continue;

    if (focusLines && !isWithinFocusWindow(i + 1, focusLines, FOCUS_WINDOW)) continue;

    // Find the previous non-empty line at the same brace depth, but only
    // within the focus window. Comparing against a distant unrelated line
    // produces false-positive indentation-jump warnings.
    let prev = -1;
    for (let j = i - 1; j >= 0; j--) {
      if (lines[j]!.trim().length > 0 && depths[j] === depths[i]) {
        if (focusLines && !isWithinFocusWindow(j + 1, focusLines, FOCUS_WINDOW)) continue;
        prev = j;
        break;
      }
    }
    if (prev === -1) continue;

    const prevIndent = lines[prev]!.search(/\S/);
    if (prevIndent >= 0 && Math.abs(indent - prevIndent) > 8) {
      warnings.push(
        `Line ${i + 1} has suspicious indentation jump (from ${prevIndent} to ${indent} spaces).`,
      );
    }
  }

  return warnings;
}

function computeStringLiteralLines(content: string): Set<number> {
  const lines = content.split("\n");
  const stringLines = new Set<number>();
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let escaped = false;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx] ?? "";
    let seenNonWhitespace = false;
    let firstNonWhitespaceIsQuote = false;

    for (let c = 0; c < line.length; c++) {
      const ch = line[c]!;

      if (!seenNonWhitespace && (ch === " " || ch === "\t")) {
        continue;
      }

      if (!seenNonWhitespace) {
        seenNonWhitespace = true;
        firstNonWhitespaceIsQuote = ch === "'" || ch === '"' || ch === "`";
        break;
      }
    }

    if (seenNonWhitespace && (inSingle || inDouble || inTemplate || firstNonWhitespaceIsQuote)) {
      stringLines.add(lineIdx);
    }

    for (let c = 0; c < line.length; c++) {
      const ch = line[c]!;

      if (escaped) {
        escaped = false;
        continue;
      }

      if (ch === "\\") {
        escaped = true;
        continue;
      }

      if (inSingle) {
        if (ch === "'") inSingle = false;
        continue;
      }

      if (inDouble) {
        if (ch === '"') inDouble = false;
        continue;
      }

      if (inTemplate) {
        if (ch === "`") inTemplate = false;
        continue;
      }

      if (ch === "'") inSingle = true;
      else if (ch === '"') inDouble = true;
      else if (ch === "`") inTemplate = true;
    }
  }

  return stringLines;
}

function isWithinFocusWindow(line: number, focusLines: Set<number>, window: number): boolean {
  for (const focus of focusLines) {
    if (Math.abs(line - focus) <= window) return true;
  }
  return false;
}

/**
 * Find the previous non-empty line index before `currentIdx`.
 *
 * NOTE: this helper is no longer used by `coherenceCheck` itself;
 * indentation jumps are now checked brace-depth-aware above. It
 * remains exported only because older tests/repros may reference it.
 */
export function findPrevNonEmptyLine(lines: string[], currentIdx: number): number {
  for (let i = currentIdx - 1; i >= 0; i--) {
    if (lines[i].trim().length > 0) return i;
  }
  return -1;
}

/**
 * Heuristic analysis of braces/parens/brackets that fall inside template
 * literals (backtick-delimited), regex literals (slash-delimited), or
 * quoted strings (single/double).
 *
 * Returns an object with:
 * - `density`: fraction of all structural characters inside these constructs.
 * - `outsideBalance`: net balance of braces outside all special constructs.
 *
 * When density >= 0.5 or outsideBalance === 0, brace-balance warnings are
 * likely false positives (e.g. regex patterns with `{n,m}` quantifiers,
 * template literals with interpolation, or shell brace expansion in strings).
 */
function computeSpecialConstructBraceDensity(content: string): {
  density: number;
  outsideBalance: number;
  unclosedSpecial: boolean;
} {
  let totalInside = 0;
  let totalOutside = 0;
  let insideBalance = 0;
  let outsideBalance = 0;
  let inTemplate = false;
  let inRegex = false;
  let regexStart = -1;
  let inDoubleQuote = false;
  let inSingleQuote = false;
  let escaped = false;
  let inCharClass = false;
  let inSingleLineComment = false;
  let inMultiLineComment = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;

    // Single-line comment: skip until newline.
    if (inSingleLineComment) {
      if (ch === "\n") inSingleLineComment = false;
      continue;
    }

    // Comments are lexical, not structural — but only recognize them when
    // we are not already inside a regex/template/string, otherwise a `#`
    // or `//` inside those constructs would be misclassified as a comment.
    if (!inRegex && !inTemplate && !inDoubleQuote && !inSingleQuote) {
      if (inMultiLineComment) {
        if (ch === "*" && content[i + 1] === "/") {
          inMultiLineComment = false;
          i++;
        }
        continue;
      }
      if (ch === "/" && content[i + 1] === "*") {
        inMultiLineComment = true;
        i++;
        continue;
      }
      // Language-agnostic single-line comment starts: //, #
      if ((ch === "/" && content[i + 1] === "/") || ch === "#") {
        inSingleLineComment = true;
        if (ch === "/") i++; // consume the second `/`
        continue;
      }
    }

    if (inDoubleQuote) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
        continue;
      } else if (ch === '"') {
        inDoubleQuote = false;
        continue;
      }
      if (ch === "{" || ch === "(" || ch === "[") {
        totalInside++;
        insideBalance++;
      }
      if (ch === "}" || ch === ")" || ch === "]") {
        totalInside++;
        insideBalance--;
      }
      continue;
    }

    if (inSingleQuote) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
        continue;
      } else if (ch === "'") {
        inSingleQuote = false;
        continue;
      }
      if (ch === "{" || ch === "(" || ch === "[") {
        totalInside++;
        insideBalance++;
      }
      if (ch === "}" || ch === ")" || ch === "]") {
        totalInside++;
        insideBalance--;
      }
      continue;
    }

    if (ch === "`") {
      if (!escaped) {
        inTemplate = !inTemplate;
      }
      escaped = false;
      continue;
    }

    if (inTemplate) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "{" || ch === "(" || ch === "[") {
        totalInside++;
        insideBalance++;
      }
      if (ch === "}" || ch === ")" || ch === "]") {
        totalInside++;
        insideBalance--;
      }
      continue;
    }

    // Regex literal heuristic: a `/` that is preceded by =, (, [, ,, ;, :, or
    // whitespace is likely the start of a regex literal.
    if (!inRegex && ch === "/" && looksLikeRegexStart(content, i)) {
      inRegex = true;
      regexStart = i;
      continue;
    }

    if (inRegex) {
      if (ch === "{" || ch === "(" || ch === "[") {
        totalInside++;
        insideBalance++;
        if (ch === "[") inCharClass = true;
      }
      if (ch === "}" || ch === ")" || ch === "]") {
        totalInside++;
        insideBalance--;
        if (ch === "]") inCharClass = false;
      }
      // End of regex literal: a `/` that is not escaped and not inside a
      // character class.
      if (ch === "/" && !inCharClass) {
        // Count slashes between regexStart and here to detect flags; a
        // simple heuristic is to end the regex at the first unescaped `/`.
        let escapedLocal = false;
        let j = regexStart + 1;
        while (j < i) {
          if (content[j] === "\\") {
            escapedLocal = !escapedLocal;
          } else {
            escapedLocal = false;
          }
          j++;
        }
        if (!escapedLocal) {
          inRegex = false;
          regexStart = -1;
        }
      }
      continue;
    }

    // Start of a double-quoted string.
    if (ch === '"') {
      inDoubleQuote = true;
      continue;
    }

    // Start of a single-quoted string.
    if (ch === "'") {
      inSingleQuote = true;
      continue;
    }

    // Outside special constructs — count as outside.
    if (ch === "{" || ch === "(" || ch === "[") {
      totalOutside++;
      outsideBalance++;
    }
    if (ch === "}" || ch === ")" || ch === "]") {
      totalOutside++;
      outsideBalance--;
    }
  }

  const total = totalInside + totalOutside;
  return {
    density: total === 0 ? 0 : totalInside / total,
    outsideBalance,
    unclosedSpecial: inTemplate || inRegex,
  };
}

function looksLikeRegexStart(content: string, idx: number): boolean {
  if (idx === 0) return true;
  const prev = content[idx - 1]!;
  // If immediately preceded by an identifier/digit char, it's division.
  if (/[a-zA-Z0-9_]/.test(prev)) return false;
  // Look back past whitespace to find the previous non-whitespace char.
  let j = idx - 1;
  while (j >= 0 && /\s/.test(content[j]!)) j--;
  if (j >= 0 && /[a-zA-Z0-9_]/.test(content[j]!)) return false;
  return /[=([,;:\s]/.test(prev);
}
