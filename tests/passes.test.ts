import { describe, it, expect } from "vitest";
import {
  escapeNormalizedFind,
  blockAnchorFind,
  lineTrimmedFind,
  oneSubstitution,
  verifiedLineSim,
  REPLACER_CHAIN,
} from "../src/edit/matching/passes.js";
import { findMatch } from "../src/edit/matching/chain.js";
import { similarity, similarityUpperBound } from "../src/edit/matching/similarity.js";

describe("oneSubstitution — equal-length, <=1 mismatched position", () => {
  it("accepts identical and single-substitution pairs", () => {
    expect(oneSubstitution("abc", "abc")).toBe(true);
    expect(oneSubstitution("abc", "axc")).toBe(true);
    expect(oneSubstitution("", "")).toBe(true);
  });

  it("rejects two substitutions and length mismatches", () => {
    expect(oneSubstitution("abc", "xyz")).toBe(false);
    expect(oneSubstitution("abc", "ab")).toBe(false);
    expect(oneSubstitution("ab", "abc")).toBe(false);
  });
});

describe("verifiedLineSim — provable fast tier over the Levenshtein DP", () => {
  it("scores exact-after-trim as 1.0 regardless of surrounding whitespace", () => {
    expect(verifiedLineSim("  foo  ", "foo")).toBe(1.0);
  });

  it("scores a single substitution on a LONG line as provable", () => {
    // One changed char out of >= 8 is negligible relative drift.
    expect(verifiedLineSim("const alpha = 01;", "const alpha = 02;")).toBe(1.0);
  });

  it("falls back to per-line Levenshtein for SHORT single-substitution pairs", () => {
    // Pathology guard: one changed char in a 2-char line is half the line
    // rewritten — that must NOT count as proof. lev("x","y") = 1 → sim 0.
    expect(verifiedLineSim("x", "y")).toBe(0);
    expect(verifiedLineSim("ab", "az")).toBe(0.5);
  });

  it("falls back to per-line Levenshtein otherwise", () => {
    // lev("kitten","sitting") = 3, maxLen = 7 → 4/7.
    expect(verifiedLineSim("kitten", "sitting")).toBeCloseTo(4 / 7, 6);
  });

  it("never underestimates the raw Levenshtein score (monotone widening)", () => {
    const pairs: [string, string][] = [
      ["const a = 1;", "const b = 1;"],
      ["if (!ready) return;", "iff (!ready) return;"],
      ["a".repeat(40), "a".repeat(39) + "b"],
      ["x", "q"],
      ["ab", "az"],
    ];
    for (const [a, b] of pairs) {
      const ta = a.trim();
      const tb = b.trim();
      const provable =
        ta === tb || (oneSubstitution(ta, tb) && Math.max(ta.length, tb.length) >= 8);
      if (provable) continue;
      const raw = 1 - levenshteinOf(ta, tb) / Math.max(ta.length, tb.length);
      expect(verifiedLineSim(a, b)).toBeGreaterThanOrEqual(raw);
    }
  });
});

/** Reference implementation for the monotonicity assertion above. */
function levenshteinOf(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j - 1]! + 1, prev[j]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

describe("REPLACER_CHAIN — tiered order", () => {
  it("runs deterministic transforms before anchored-fuzzy passes", () => {
    const names = REPLACER_CHAIN.map((r) => r.name);
    const idx = (name: string) => names.indexOf(name);
    // Tier 3 normalizations must precede tier 4 anchored-fuzzy passes.
    for (const normalization of [
      "whitespace_normalized",
      "indentation_flexible",
      "escape_normalized",
      "unicode_normalized",
    ]) {
      expect(idx(normalization), `${normalization} before block_anchor`).toBeLessThan(
        idx("block_anchor"),
      );
      expect(idx(normalization), `${normalization} before block_anchor_levenshtein`).toBeLessThan(
        idx("block_anchor_levenshtein"),
      );
      expect(idx(normalization), `${normalization} before fuzzy_boundary`).toBeLessThan(
        idx("fuzzy_boundary"),
      );
    }
    // Reinforcement passes stay last; search-only flag travels with the pass.
    expect(names.slice(-3)).toEqual(["robust_trimmed", "robust_backslash", "token_overlap"]);
    expect(REPLACER_CHAIN.find((r) => r.name === "fuzzy_boundary")?.searchOnly).toBe(true);
    expect(REPLACER_CHAIN.find((r) => r.name === "token_overlap")?.searchOnly).toBe(true);
  });

  it("absorbed multi_occurrence: exact tier-2 name set is stable", () => {
    const names = REPLACER_CHAIN.map((r) => r.name);
    expect(names).not.toContain("multi_occurrence");
    expect(names[0]).toBe("simple");
    expect(names[1]).toBe("line_trimmed");
  });

  it("tier-3 normalization shadows block_anchor when both could match", () => {
    // Internal whitespace-run drift: line_trimmed fails (trim is end-only),
    // while block_anchor's exact-trimmed boundaries and whitespace collapse
    // both qualify — the deterministic transform must win by order.
    const hit = findMatch("A\nfoo  bar\nB", "A\nfoo bar\nB");
    expect(hit?.passName).toBe("whitespace_normalized");
    expect(hit?.actual).toBe("A\nfoo  bar\nB");
  });
});

describe("lineTrimmedFind — blank-frame absorption (former multi_occurrence)", () => {
  it("matches a query wrapped in leading/trailing blank lines", () => {
    const original = "function a() {}\n\nfunction b() {}\n";
    const query = "\nfunction b() {}\n";
    expect(lineTrimmedFind(original, query)).toBe("function b() {}");
  });

  it("still matches without any blank-line frame", () => {
    const original = "A\n  b  \nC";
    expect(lineTrimmedFind(original, "A\nb\nC")).toBe("A\n  b  \nC");
  });

  it("findMatch attributes the absorbed case to line_trimmed", () => {
    // Indented file lines defeat simple's raw includes; the blank-line frame
    // alone used to be multi_occurrence's only edge over line_trimmed.
    const original = "x\n\n  y\n  z\n";
    const hit = findMatch(original, "\ny\nz");
    expect(hit?.passName).toBe("line_trimmed");
    expect(hit?.actual).toBe("  y\n  z");
  });
});

describe("similarity bounds", () => {
  it("fast path: identical strings return 1.0", () => {
    expect(similarity("same string", "same string")).toBe(1.0);
  });

  it("upper bound never underestimates similarity", () => {
    const pairs: [string, string][] = [
      ["abcdefghij", "abcyz"],
      ["hello world", "helqo worlt"],
      ["", ""],
      ["abc", ""],
      ["a\r\nb", "a\nb"],
    ];
    for (const [a, b] of pairs) {
      expect(similarityUpperBound(a, b)).toBeGreaterThanOrEqual(similarity(a, b));
    }
  });

  it("length-ratio bound rejects provably-dissimilar pairs", () => {
    // 10 chars vs 100 chars: bound = 2*10/110 ≈ 0.18 < any sane threshold.
    expect(similarityUpperBound("a".repeat(10), "b".repeat(100))).toBeLessThan(0.2);
  });
});

describe("fuzzy_boundary — provable boundary conservatism", () => {
  it("does NOT anchor on tiny single-substitution boundaries (pathology guard)", () => {
    // Boundaries "a"→"b" and "c"→"q" are single substitutions of 1-char
    // lines: raw lev-sim 0, and too short to be provable. The old prefilter
    // (< 0.75) skipped the window; the provable tier must not rescue it.
    const original = "a\nfoo\nbar\nc\nother\nstuff";
    expect(findMatch(original, "b\nfoo\nbar\nq")).toBeNull();
  });

  it("anchors on long-line single-substitution boundaries", () => {
    const first = "const alpha = 01;";
    const last = "export default gamma;";
    const query = ["const alpha = 02;", "  return beta.shift();", "export default gamma;"].join(
      "\n",
    );
    const original = [first, "  return beta.shift();", last, "// trailing"].join("\n");
    const hit = findMatch(original, query);
    expect(hit?.passName).toBe("fuzzy_boundary");
    expect(hit?.actual).toBe(original.split("\n").slice(0, 3).join("\n"));
  });
});

describe("escapeNormalizedFind — extended escapes", () => {
  it("matches \\r escape in query to real CR in content", () => {
    const result = escapeNormalizedFind("hello\rworld", "hello\\rworld");
    expect(result).not.toBeNull();
    expect(result).toBe("hello\rworld");
  });

  it("matches \\` escape in query to real backtick in content", () => {
    const result = escapeNormalizedFind("hello`world", "hello\\`world");
    expect(result).not.toBeNull();
    expect(result).toBe("hello`world");
  });

  it("matches \\$ escape in query to real dollar in content", () => {
    const result = escapeNormalizedFind("hello$world", "hello\\$world");
    expect(result).not.toBeNull();
    expect(result).toBe("hello$world");
  });

  it("matches literal backslash-n (two chars) as real newline", () => {
    // unescape order: \\\\ then \\n then \\t etc.
    const result = escapeNormalizedFind("hello\nworld", "hello\\\\nworld");
    expect(result).not.toBeNull();
    expect(result).toBe("hello\nworld");
  });

  it("returns null when no escape variant matches", () => {
    const result = escapeNormalizedFind("hello world", "hello\\zworld");
    expect(result).toBeNull();
  });

  it("preserves ordering: backslash-n becomes newline, not literal backslash-n", () => {
    // The unescape order is: \\ first, then \n. This means a query
    // containing \\n (two backslashes + n) is first reduced to \\n
    // (one backslash + n), then to a real newline. A content string that
    // already has a real newline should match.
    const result = escapeNormalizedFind("hello\nworld", "hello\\nworld");
    expect(result).not.toBeNull();
    expect(result).toBe("hello\nworld");
  });

  it("handles multiple escape sequences in one string", () => {
    const result = escapeNormalizedFind("a\tb\nc\rd`e$f", "a\\tb\\nc\\rd`e$f");
    expect(result).not.toBeNull();
    expect(result).toBe("a\tb\nc\rd`e$f");
  });

  it("handles escaped backslash producing a literal backslash", () => {
    // \\ in query becomes a single backslash in content.
    const result = escapeNormalizedFind("path\\dir", "path\\\\dir");
    expect(result).not.toBeNull();
    expect(result).toBe("path\\dir");
  });

  it("returns null for empty query", () => {
    const result = escapeNormalizedFind("anything", "");
    expect(result).toBeNull();
  });

  it("returns null when unescaped content is not present", () => {
    const result = escapeNormalizedFind("hello world", "hello\\rworld");
    expect(result).toBeNull();
  });
});

describe("blockAnchorFind — threshold boundaries", () => {
  it("rejects a single candidate with similarity below 0.3", () => {
    // 10-char middle with LCS=2 → similarity = 0.2.
    const original = "A\naxxxxxxxxj\nB";
    const oldContent = "A\nabcdefghij\nB";
    const result = blockAnchorFind(original, oldContent);
    expect(result).toBeNull();
  });

  it("accepts a single candidate with similarity exactly 0.3", () => {
    const original = "A\nabcyz\nB";
    const oldContent = "A\nabcde\nB";
    const result = blockAnchorFind(original, oldContent);
    expect(result).not.toBeNull();
    expect(result).toBe("A\nabcyz\nB");
  });

  it("rejects multiple candidates when best similarity is below 0.5", () => {
    // First candidate: LCS("abxxx", "abcde") = 2 → similarity = 0.4.
    // Second candidate: LCS("vwxyz", "abcde") = 0 → similarity = 0.
    const original = "A\nabxxx\nB\nA\nvwxyz\nB";
    const oldContent = "A\nabcde\nB";
    const result = blockAnchorFind(original, oldContent);
    expect(result).toBeNull();
  });

  it("accepts multiple candidates when best similarity is 0.5 or above", () => {
    // First candidate: LCS("abcyz", "abcde") = 3 → similarity = 0.6.
    // Second candidate: LCS("vwxyz", "abcde") = 0 → similarity = 0.
    const original = "A\nabcyz\nB\nA\nvwxyz\nB";
    const oldContent = "A\nabcde\nB";
    const result = blockAnchorFind(original, oldContent);
    expect(result).not.toBeNull();
  });

  it("rejects when first line does not match", () => {
    const result = blockAnchorFind("X\nabcde\nB", "A\nabcde\nB");
    expect(result).toBeNull();
  });

  it("rejects when last line does not match", () => {
    const result = blockAnchorFind("A\nabcde\nX", "A\nabcde\nB");
    expect(result).toBeNull();
  });

  it("rejects blocks with fewer than 3 lines", () => {
    const result = blockAnchorFind("A\nB", "A\nB");
    expect(result).toBeNull();
  });

  it("accepts exact 3-line block", () => {
    const result = blockAnchorFind("A\nB\nC", "A\nB\nC");
    expect(result).not.toBeNull();
    expect(result).toBe("A\nB\nC");
  });

  it("accepts block with empty middle", () => {
    const result = blockAnchorFind("A\n\nB", "A\n\nB");
    expect(result).not.toBeNull();
    expect(result).toBe("A\n\nB");
  });

  it("prefers higher similarity among multiple candidates", () => {
    // First candidate is an exact match (similarity 1.0).
    // Second candidate has lower similarity.
    const original = "A\nabxyz\nB\nA\nabcde\nB";
    const oldContent = "A\nabxyz\nB";
    const result = blockAnchorFind(original, oldContent);
    expect(result).not.toBeNull();
    // Should pick the better match (the exact one)
    expect(result!.split("\n").length).toBe(3);
  });

  it("returns verbatim text from original, not from query", () => {
    const original = "A\n  abc  \nB";
    const oldContent = "A\nabc\nB";
    const result = blockAnchorFind(original, oldContent);
    expect(result).not.toBeNull();
    expect(result).toBe("A\n  abc  \nB");
  });
});
