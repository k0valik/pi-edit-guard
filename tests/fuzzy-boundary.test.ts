import { describe, it, expect } from "vitest";
import { fuzzyBoundaryFind } from "../src/edit/matching/passes.js";

// In-the-wild motivation (old-era corpus, 16 calls): models paraphrase ONE
// line inside an otherwise verbatim block. block_anchor_levenshtein refuses
// because it demands EXACT trimmed first/last lines; this pass matches the
// whole block at >=0.9 mean similarity with a strong boundary anchor and a
// UNIQUE qualifying window.

describe("fuzzyBoundaryFind", () => {
  const file = [
    "import { a } from './a';",
    "",
    "/** Canonical list of path-like argument keys across Pi tools. */",
    "export const PATH_KEYS = ['path'] as const;",
    "",
    "export const extractPath = (args: Record<string, unknown>): string | null => {",
    "  return typeof args.path === 'string' ? args.path : null;",
    "};",
  ].join("\n");

  it("matches when one boundary line drifted by a word", () => {
    // First line paraphrased ("across all Pi tools"), rest verbatim.
    const query = [
      "/** Canonical list of path-like argument keys across all Pi tools. */",
      "export const PATH_KEYS = ['path'] as const;",
      "",
      "export const extractPath = (args: Record<string, unknown>): string | null => {",
    ].join("\n");
    const hit = fuzzyBoundaryFind(file, query);
    expect(hit).toBeTruthy();
    expect(hit).toContain("export const PATH_KEYS");
  });

  it("matches when a single interior line drifted", () => {
    // Same line count as the file's block; middle line paraphrased.
    const query = [
      "export const extractPath = (args: Record<string, unknown>): string | null => {",
      "  return typeof args['path'] === 'string' ? args.path : null;",
      "};",
    ].join("\n");
    const hit = fuzzyBoundaryFind(file, query);
    expect(hit).toBeTruthy();
  });

  it("rejects below-threshold drift", () => {
    const query = [
      "export function totallyDifferent(first: number, second: string): boolean {",
      "  const combined = `${first}-${second}`;",
      "  return combined.length > 3 && second.startsWith('x');",
      "}",
    ].join("\n");
    expect(fuzzyBoundaryFind(file, query)).toBeNull();
  });

  it("rejects when multiple windows qualify (not unique)", () => {
    const block = ["function handlerOne() {", "  doWork('one');", "  return true;", "}"].join("\n");
    const twinFile = [block, "", "// spacer", "", block].join("\n");
    // Query is a slightly-drifted copy of the duplicated block: two windows
    // qualify, so the pass must refuse instead of guessing.
    const query = [
      "function handlerOne() {",
      "  doWork('one'); /* tweaked */",
      "  return true;",
      "}",
    ].join("\n");
    expect(fuzzyBoundaryFind(twinFile, query)).toBeNull();
  });

  it("requires a strong boundary anchor", () => {
    // Interior similar, but both boundaries are unrelated -> no anchor.
    const query = [
      "// completely unrelated header comment alpha",
      "export const PATH_KEYS = ['path'] as const;",
      "",
      "// completely unrelated footer comment omega",
    ].join("\n");
    expect(fuzzyBoundaryFind(file, query)).toBeNull();
  });

  it("skips short blocks (< 3 lines)", () => {
    expect(fuzzyBoundaryFind(file, "export const PATH_KEYS = ['path'] as const;")).toBeNull();
  });

  it("returns text that exists verbatim in the original", () => {
    const query = [
      "/** Canonical list of path-like argument keys across all Pi tools. */",
      "export const PATH_KEYS = ['path'] as const;",
    ];
    // 2-line queries are skipped entirely by design; use a 3-line one.
    const threeLine = [...query, ""].join("\n");
    const hit = fuzzyBoundaryFind(file, threeLine);
    expect(hit === null || file.includes(hit)).toBe(true);
  });
});
