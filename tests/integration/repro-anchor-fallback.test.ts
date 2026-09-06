import { describe, it, expect } from "vitest";
import { resolveBlocks } from "../../src/edit/pipeline/resolve.js";

describe("repro: anchor fallback", () => {
  it("uses closest candidate as fallback anchor when primary anchor is not found", () => {
    const content = `function calculateTotal(a, b) {
  const result = a + b;
  return result;
}
`;
    const blocks = [
      {
        path: "test.ts",
        oldText: "  return result;",
        newText: "  return result * 2;",
        anchor: "function calculateT0tal(a, b) {", // typo: 0 instead of o
      },
    ];
    const result = resolveBlocks(content, blocks, "test.ts");
    expect(result.resolved.length).toBe(1);
    expect(result.resolved[0]!.edit.newText).toBe("  return result * 2;");
    const diag = result.diagnostics.find((d) => d.index === 0);
    expect(diag).toBeDefined();
    expect(diag!.anchorFallback).toBe(true);
    expect(diag!.fallbackCandidate).toBeDefined();
    expect(diag!.fallbackCandidate!.similarity).toBeGreaterThan(0.7);
  });

  it("hallucinated anchor + verbatim-unique oldText applies via full retry (P5)", () => {
    const content = `function foo() {
  const x = 1;
  return x;
}
`;
    const blocks = [
      {
        path: "test.ts",
        oldText: "  return x;",
        newText: "  return x + 1;",
        anchor: "completely unrelated anchor text",
      },
    ];
    const result = resolveBlocks(content, blocks, "test.ts");
    expect(result.ok).toBe(true);
    expect(result.resolved).toHaveLength(1);
    expect(result.diagnostics[0]?.anchorFallback).toBe(true);
  });

  it("does not use fallback when oldText is ambiguous in the fallback window", () => {
    const content = `AAA
BBB
AAA
`;
    const blocks = [
      {
        path: "test.txt",
        oldText: "AAA",
        newText: "ZZZ",
        anchor: "not_in_file_typo", // not found, fallback might find something
      },
    ];
    const result = resolveBlocks(content, blocks, "test.txt");
    // "AAA" appears 2 times — even with a fallback anchor, oldText is ambiguous
    expect(result.resolved.length).toBe(0);
    const hasAnchorNotFound = result.errors.some((e) => e.kind === "anchor-not-found");
    expect(hasAnchorNotFound).toBe(true);
  });
});
