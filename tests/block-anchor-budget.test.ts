import { describe, it, expect } from "vitest";
import { blockAnchorFind } from "../src/edit/matching/passes.js";
import { findMatch } from "../src/edit/matching/chain.js";

/**
 * Budget guard for blockAnchorFind (perf, mined 2026-09-09).
 *
 * A 157-line query with generic boundaries (`// ───…` + `}`) matched 286
 * candidate windows; scoring each with an LCS DP cost ~37 s live. The guard
 * refuses such shapes fast (null) so the chain falls through to the cheaper
 * block_anchor_levenshtein twin, which rescues equal-structure drift in ms
 * with the identical span.
 */
function buildPathologicalShape() {
  const sep = "// " + "=".repeat(60);
  const block = (tag: string) => {
    const lines = [sep, `// block ${tag}`];
    for (let i = 0; i < 48; i++) {
      lines.push(`const ${tag}_var${i} = "value-${tag}-${i}-${"x".repeat(60)}";`);
    }
    lines.push("}");
    return lines.join("\n");
  };
  const tags = ["aa", "bb", "cc", "dd", "ee", "ff", "gg", "hh", "ii", "jj"];
  const file = `${tags.map(block).join("\n")}\n`;
  // Query = block ee with a 1-char drift on one middle line: exact
  // boundaries, equal line count, near-verbatim middle.
  const queryLines = block("ee").split("\n");
  queryLines[10] = queryLines[10]!.replace("value-", "valuX-");
  return { file, query: queryLines.join("\n"), expected: block("ee") };
}

describe("blockAnchorFind budget guard", () => {
  it("refuses generic-boundary × large-middle shapes instead of hanging", () => {
    const { file, query } = buildPathologicalShape();
    // 286-candidate-class shape pre-fix: ~1.8 s on this synthetic input
    // (~37 s on the real 157-line snapshot). Must return (null) fast now.
    const t0 = performance.now();
    const hit = blockAnchorFind(file, query);
    const elapsed = performance.now() - t0;
    expect(hit).toBeNull();
    expect(elapsed).toBeLessThan(2000);
  });

  it("chain still rescues via block_anchor_levenshtein with the exact span", () => {
    const { file, query, expected } = buildPathologicalShape();
    const m = findMatch(file, query);
    expect(m?.passName).toBe("block_anchor_levenshtein");
    expect(m?.actual).toBe(expected);
  });

  it("distinctive boundaries with drift still match via block_anchor", () => {
    const file = [
      "function alpha() {",
      '  const marker = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";',
      '  const body = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";',
      "  return marker + body;",
      "}",
      "",
      "function beta() {",
      '  const other = "cccccccccccccccccccccccccccccccccccccccc";',
      "  return other;",
      "}",
    ].join("\n");
    // 1-char drift in the middle, unique anchors.
    const query = [
      "function alpha() {",
      '  const marker = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";',
      '  const body = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbXb";',
      "  return marker + body;",
      "}",
    ].join("\n");
    const m = findMatch(file, query);
    expect(m?.passName).toBe("block_anchor");
    expect(m?.actual).toBe(query.replace("bbXb", "bbbb"));
  });
});
