import { describe, it, expect } from "vitest";
import {
  findAllExactSpans,
  buildCandidatePreview,
  findNearMisses,
} from "../src/edit/matching/candidates.js";
import { findClosestCandidate } from "../src/edit/matching/closest.js";
import { similarity } from "../src/edit/matching/similarity.js";

describe("findAllExactSpans", () => {
  it("returns empty array for empty needle", () => {
    expect(findAllExactSpans("hello world", "")).toEqual([]);
  });

  it("finds single occurrence", () => {
    const spans = findAllExactSpans("hello world", "world");
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      start: 6,
      end: 11,
      similarity: 1.0,
    });
    expect(spans[0]!.startLine).toBeGreaterThan(0);
    expect(spans[0]!.endLine).toBeGreaterThanOrEqual(spans[0]!.startLine);
  });

  it("finds multiple overlapping occurrences", () => {
    const spans = findAllExactSpans("aaa", "aa");
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({ start: 0, end: 2 });
    expect(spans[1]).toMatchObject({ start: 1, end: 3 });
  });

  it("returns empty array for needle not in haystack", () => {
    expect(findAllExactSpans("hello world", "goodbye")).toEqual([]);
  });

  it("handles multi-line needles with correct line numbers", () => {
    const content = "line1\nline2\nline3\nline2\nline3";
    const spans = findAllExactSpans(content, "line2\nline3");
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({ startLine: 2, endLine: 3 });
    // end offset is past the last char of the match; subtract 1 for line lookup
    expect(spans[1]).toMatchObject({ startLine: 4, endLine: 5 });
  });
});

describe("buildCandidatePreview", () => {
  const content = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj";

  it("builds preview with default context", () => {
    // match "d\ne\nf" at lines 4-6; end is start of next line
    const start = content.indexOf("d");
    const end = content.indexOf("g");
    const preview = buildCandidatePreview(content, start, end);

    expect(preview.before).toHaveLength(2);
    expect(preview.before[0]).toMatchObject({ line: 2, content: "b" });
    expect(preview.before[1]).toMatchObject({ line: 3, content: "c" });

    expect(preview.matched).toHaveLength(3);
    expect(preview.matched[0]).toMatchObject({ line: 4, content: "d" });
    expect(preview.matched[1]).toMatchObject({ line: 5, content: "e" });
    expect(preview.matched[2]).toMatchObject({ line: 6, content: "f" });
    expect(preview.matchedLinesOmitted).toBe(0);

    expect(preview.after).toHaveLength(2);
    expect(preview.after[0]).toMatchObject({ line: 7, content: "g" });
    expect(preview.after[1]).toMatchObject({ line: 8, content: "h" });
  });

  it("truncates matched lines and reports omitted count", () => {
    // match lines 4-10 (7 lines) with maxMatchedLines=3
    const start = content.indexOf("d");
    const end = content.length; // after last char 'j'
    const preview = buildCandidatePreview(content, start, end, 2, 3);

    expect(preview.matched).toHaveLength(3);
    expect(preview.matchedLinesOmitted).toBe(4); // lines 7-10 omitted
  });

  it("clamps context at file boundaries", () => {
    // match at the very start
    const preview = buildCandidatePreview(content, 0, 1); // "a"
    expect(preview.before).toHaveLength(0);
    expect(preview.matched[0]).toMatchObject({ line: 1, content: "a" });
  });
});

describe("findNearMisses", () => {
  it("returns empty array for empty query", () => {
    expect(findNearMisses("hello world", "")).toEqual([]);
  });

  it("finds near-miss candidates", () => {
    const content = `function hello() {\n  return 42;\n}\nfunction hello() {\n  return 43;\n}\n`;
    const query = "function hello() {\n  return 43;\n}\n";
    const misses = findNearMisses(content, query, 5);

    expect(misses.length).toBeGreaterThan(0);
    expect(misses[0]!.similarity).toBeGreaterThan(0.5);
    expect(misses[0]!.startLine).toBeGreaterThan(0);
    expect(misses[0]!.endLine).toBeGreaterThanOrEqual(misses[0]!.startLine);
  });

  it("returns candidates sorted by similarity descending", () => {
    const content = "foo\nbar\nbaz\nfoo\nbar\nqux";
    const query = "foo\nbar\nqux";
    const misses = findNearMisses(content, query, 5);

    for (let i = 1; i < misses.length; i++) {
      expect(misses[i]!.similarity).toBeLessThanOrEqual(misses[i - 1]!.similarity);
    }
  });

  it("caps results at maxCandidates", () => {
    const content = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const query = "line 0\nline 1\nline 2";
    const misses = findNearMisses(content, query, 3);
    expect(misses).toHaveLength(3);
  });
});

describe("failure-diagnostics perf (pool entry #773 hotspot)", () => {
  // 879-line file whose lines share vocabulary with a 94-line query — the
  // shape that sent the naive anchors-x-windows DP walk into multi-minute
  // not-found diagnostics (995s measured in the wild).
  const makeHotFile = () => {
    const lines: string[] = [];
    for (let i = 0; i < 879; i++) {
      if (i % 9 === 0) {
        lines.push(`interface Block${i} { type?: string; text?: string; name?: string; }`);
      } else if (i % 3 === 0) {
        lines.push(`  tokens += estimateTokens(message); // ${i}`);
      } else {
        lines.push(`const state${i} = { provider, usage, stopReason }; // ${i}`);
      }
    }
    return lines.join("\n");
  };
  const hotFile = makeHotFile();
  const hotQuery = Array.from({ length: 94 }, (_, i) =>
    i % 9 === 0
      ? `interface BlockX { type?: string; text?: string; name?: string; }`
      : `  tokens += estimateTokens(message); // q${i}`,
  ).join("\n");

  it("findNearMisses stays sub-second on the pathological shape", () => {
    const t0 = performance.now();
    const misses = findNearMisses(hotFile, hotQuery, 5);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(2000);
    expect(misses.length).toBeGreaterThan(0);
  });

  it("findClosestCandidate stays sub-second on the pathological shape", () => {
    const t0 = performance.now();
    const c = findClosestCandidate(hotFile, hotQuery);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(2000);
    expect(c).not.toBeNull();
  });

  it("findNearMisses matches the naive top-K reference exactly", () => {
    const content = Array.from({ length: 60 }, (_, i) => `line alpha ${i} beta`).join("\n");
    const query = "line alpha 10 beta\nline alpha 11 beta\nline gamma delta";
    const got = findNearMisses(content, query, 5);

    // Naive reference: every window of query-sized..2x from every anchor line.
    const origLines = content.split("\n");
    const naive: { start: number; end: number; sim: number }[] = [];
    for (let s = 0; s < origLines.length; s++) {
      if (!origLines[s]!.includes("alpha")) continue;
      for (let e = s + 2; e <= Math.min(s + 6, origLines.length); e++) {
        const text = origLines.slice(s, e).join("\n");
        naive.push({ start: s + 1, end: e, sim: similarity(query, text) });
      }
    }
    naive.sort((a, b) => b.sim - a.sim);
    const topK = naive.slice(0, 5).filter((n) => n.sim >= 0.2);

    expect(got.map((g) => g.startLine)).toEqual(topK.map((n) => n.start));
    expect(got.map((g) => g.endLine)).toEqual(topK.map((n) => n.end));
  });
});
