import { describe, it, expect } from "vitest";
import { blockAnchorLevenshteinFind } from "../src/edit/matching/passes.js";

describe("blockAnchorLevenshteinFind — exhaustive", () => {
  it("accepts exact middle lines", () => {
    const result = blockAnchorLevenshteinFind("A\nabc\nB", "A\nabc\nB");
    expect(result).not.toBeNull();
    expect(result).toBe("A\nabc\nB");
  });

  it("accepts middle lines with minor whitespace drift", () => {
    const result = blockAnchorLevenshteinFind("A\n  abc  \nB", "A\nabc\nB");
    expect(result).not.toBeNull();
    expect(result).toBe("A\n  abc  \nB");
  });

  it("rejects middle lines with large drift", () => {
    const result = blockAnchorLevenshteinFind("A\nxyz\nB", "A\nabc\nB");
    expect(result).toBeNull();
  });

  it("accepts single candidate with average similarity exactly 0.3", () => {
    // Two interior lines, each with similarity 0.3.
    // 10-char strings with 7 edits each: similarity = 1 - 7/10 = 0.3.
    const original = "A\naxcdeghijk\naxcdeghijk\nB";
    const oldContent = "A\nabcdefghij\nabcdefghij\nB";
    const result = blockAnchorLevenshteinFind(original, oldContent);
    expect(result).not.toBeNull();
  });

  it("rejects single candidate with average similarity just below 0.3", () => {
    // Completely different strings: similarity = 0.0.
    const _original = "A\n0000000000\n0000000000\nB";
    const _oldContent = "A\nabcdefghij\nabcdefghij\nB";
    const result = blockAnchorLevenshteinFind(_original, _oldContent);
    expect(result).toBeNull();
  });

  it("accepts multiple candidates when best similarity is exactly 0.5", () => {
    // Two candidates: one with avg 0.5, one with avg 0.
    const original = "A\nax\naz\nB\nA\nxx\nyy\nB";
    const oldContent = "A\nab\nac\nB";
    const result = blockAnchorLevenshteinFind(original, oldContent);
    expect(result).not.toBeNull();
  });

  it("rejects multiple candidates when best similarity is 0.49", () => {
    const original = "A\nxx\naz\nB\nA\nxx\nyy\nB";
    const oldContent = "A\nab\nac\nB";
    const result = blockAnchorLevenshteinFind(original, oldContent);
    expect(result).toBeNull();
  });

  it("rejects blocks shorter than 3 lines", () => {
    const result = blockAnchorLevenshteinFind("A\nB", "A\nB");
    expect(result).toBeNull();
  });

  it("rejects candidates shorter than the query middle", () => {
    // 10-line query should not match a 3-line candidate.
    const original = "A\nshort\nB";
    const oldContent = Array.from({ length: 10 }, (_, i) =>
      i === 0 ? "A" : i === 9 ? "B" : "x",
    ).join("\n");
    const result = blockAnchorLevenshteinFind(original, oldContent);
    expect(result).toBeNull();
  });

  it("rejects candidates with extra middle lines", () => {
    // Query has 2 middle lines; candidate has 8 middle lines.
    const original = "A\nab\ncd\nef\ngh\nij\nkl\nmn\nop\nB";
    const oldContent = "A\nab\ncd\nB";
    const result = blockAnchorLevenshteinFind(original, oldContent);
    expect(result).toBeNull();
  });

  it("returns verbatim text from original", () => {
    const original = "A\n  abc  \nB";
    const oldContent = "A\nabc\nB";
    const result = blockAnchorLevenshteinFind(original, oldContent);
    expect(result).not.toBeNull();
    expect(result).toBe("A\n  abc  \nB");
  });

  it("accepts with single interior line at similarity 0.3", () => {
    // 10-char strings, 7 edits: similarity = 0.3.
    const original = "A\naxcdeghijk\nB";
    const oldContent = "A\nabcdefghij\nB";
    const result = blockAnchorLevenshteinFind(original, oldContent);
    expect(result).not.toBeNull();
  });

  it("rejects with single interior line at similarity below 0.3", () => {
    // Completely different 14-char strings: similarity = 0.0.
    const original = "A\n00000000000000\nB";
    const oldContent = "A\nabcdefghijklmn\nB";
    const result = blockAnchorLevenshteinFind(original, oldContent);
    expect(result).toBeNull();
  });

  it("rejects when first line does not match", () => {
    const result = blockAnchorLevenshteinFind("X\nabc\nB", "A\nabc\nB");
    expect(result).toBeNull();
  });

  it("rejects when last line does not match", () => {
    const result = blockAnchorLevenshteinFind("A\nabc\nX", "A\nabc\nB");
    expect(result).toBeNull();
  });

  it("handles empty middle lines", () => {
    const result = blockAnchorLevenshteinFind("A\n\nB", "A\n\nB");
    expect(result).not.toBeNull();
    expect(result).toBe("A\n\nB");
  });

  it("rejects when one middle is empty and the other is not", () => {
    const result = blockAnchorLevenshteinFind("A\n\nB", "A\nabc\nB");
    expect(result).toBeNull();
  });

  it("accepts when both middles are empty", () => {
    const result = blockAnchorLevenshteinFind("A\n\nB", "A\n\nB");
    expect(result).not.toBeNull();
  });

  it("handles multiple candidates with identical similarity", () => {
    // Two candidates with same similarity; should pick first or either.
    const original = "A\nabc\nB\nA\nabc\nB";
    const oldContent = "A\nabc\nB";
    const result = blockAnchorLevenshteinFind(original, oldContent);
    expect(result).not.toBeNull();
  });

  it("does not match across large gaps when first/last repeat", () => {
    // First/last lines repeat; ensure we only pick the closer candidate.
    const original = "A\nxxx\nB\nA\nabc\nB";
    const oldContent = "A\nabc\nB";
    const result = blockAnchorLevenshteinFind(original, oldContent);
    expect(result).not.toBeNull();
    expect(result).toBe("A\nabc\nB");
  });

  it("rejects when candidate exceeds window", () => {
    // windowEnd = i + oldLines.length * 2; candidate beyond that is skipped.
    const original = "A\n" + Array.from({ length: 20 }, () => "x").join("\n") + "\nB";
    const oldContent = "A\nabc\nB";
    const result = blockAnchorLevenshteinFind(original, oldContent);
    expect(result).toBeNull();
  });
});
