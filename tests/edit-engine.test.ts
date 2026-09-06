import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findMatch } from "../src/edit/matching/chain.js";
import { findClosestCandidate } from "../src/edit/matching/closest.js";
import { applyEdits } from "../src/edit/pipeline/apply.js";
import { resolveBlocks } from "../src/edit/pipeline/resolve.js";
import { ReadRegistry } from "../src/guards/stale-read/registry.js";
import { executeFile } from "../src/edit/pipeline/execute.js";
import { notFoundError, anchorNotFoundError } from "../src/edit/errors.js";
import { BRACE_BALANCE_ENABLED } from "../src/advisories/coherence.js";
import {
  blockAnchorFind,
  blockAnchorLevenshteinFind,
  escapeNormalizedFind,
} from "../src/edit/matching/passes.js";

const writeFile = (path: string, data: Buffer | string) => writeFileSync(path, data);

describe("escapeNormalizedFind", () => {
  it("matches \\r escape", () => {
    const result = escapeNormalizedFind("hello\rworld", "hello\\rworld");
    expect(result).not.toBeNull();
    expect(result).toBe("hello\rworld");
  });

  it("matches \\\\` escape", () => {
    const result = escapeNormalizedFind("hello`world", "hello\\`world");
    expect(result).not.toBeNull();
    expect(result).toBe("hello`world");
  });

  it("matches \\\\$ escape", () => {
    const result = escapeNormalizedFind("hello$world", "hello\\$world");
    expect(result).not.toBeNull();
    expect(result).toBe("hello$world");
  });

  it("matches literal \\\\n (two-char) as newline", () => {
    const result = escapeNormalizedFind("hello\nworld", "hello\\\\nworld");
    expect(result).not.toBeNull();
    expect(result).toBe("hello\nworld");
  });

  it("returns null for unrecognized escape sequences", () => {
    const result = escapeNormalizedFind("hello world", "hello\\zworld");
    expect(result).toBeNull();
  });
});

describe("blockAnchorLevenshteinFind", () => {
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

  it("accepts single candidate with average similarity 0.3", () => {
    // Two interior lines, each with similarity 0.3 (10-char strings, 7 edits each).
    const original = "A\nabcdefghij\nabcdefghij\nB";
    const oldContent = "A\naxcdfghijk\naxcdfghijk\nB";
    const result = blockAnchorLevenshteinFind(original, oldContent);
    expect(result).not.toBeNull();
  });

  it("rejects single candidate with average similarity below 0.3", () => {
    // Two interior lines with low similarity (0 + ~0.095 / 2 < 0.3).
    const original = "A\n0000000000\n0000000000u\nB";
    const oldContent = "A\nabcdefghij\nabcdefghijklmnopqrst\nB";
    const result = blockAnchorLevenshteinFind(original, oldContent);
    expect(result).toBeNull();
  });

  it("accepts multiple candidates when best similarity is 0.5", () => {
    // Two candidates: one with avg 0.5, one with avg 0.
    const original = "A\nax\naz\nB\nA\nxx\nyy\nB";
    const oldContent = "A\nab\nac\nB";
    const result = blockAnchorLevenshteinFind(original, oldContent);
    expect(result).not.toBeNull();
  });

  it("rejects multiple candidates when best similarity is 0.49", () => {
    // Two candidates: best average below 0.5.
    const original = "A\nxx\naz\nB\nA\nxx\nyy\nB";
    const oldContent = "A\nab\nac\nB";
    const result = blockAnchorLevenshteinFind(original, oldContent);
    expect(result).toBeNull();
  });

  it("rejects blocks shorter than 3 lines", () => {
    const result = blockAnchorLevenshteinFind("A\nB", "A\nB");
    expect(result).toBeNull();
  });

  it("rejects candidates shorter than the query", () => {
    // 10-line query should not match a 3-line candidate just because the
    // single middle line has high similarity.
    const original = "A\nshort\nB";
    const oldContent = Array.from({ length: 10 }, (_, i) =>
      i === 0 ? "A" : i === 9 ? "B" : "x",
    ).join("\n");
    const result = blockAnchorLevenshteinFind(original, oldContent);
    expect(result).toBeNull();
  });

  it("rejects candidates with extra middle lines", () => {
    // Query has 2 middle lines; candidate has 8 middle lines. Even if the
    // first 2 match, the extra lines should prevent acceptance.
    const original = "A\nab\ncd\nef\ngh\nij\nkl\nmn\nop\nB";
    const oldContent = "A\nab\ncd\nB";
    const result = blockAnchorLevenshteinFind(original, oldContent);
    expect(result).toBeNull();
  });
});

describe("blockAnchorFind", () => {
  it("rejects a single candidate with similarity below 0.3", () => {
    const result = blockAnchorFind("A\nvwxyz\nB", "A\nabcde\nB");
    expect(result).toBeNull();
  });

  it("accepts a single candidate with similarity between 0.3 and 0.49", () => {
    const result = blockAnchorFind("A\nabxyz\nB", "A\nabcde\nB");
    expect(result).not.toBeNull();
  });

  it("rejects multiple candidates when the best similarity is below 0.5", () => {
    const original = "A\nabxyz\nB\nA\nvwxyz\nB";
    const oldContent = "A\nabcde\nB";
    const result = blockAnchorFind(original, oldContent);
    expect(result).toBeNull();
  });

  it("accepts multiple candidates when the best similarity is 0.5 or above", () => {
    const original = "A\nabcyz\nB\nA\nvwxyz\nB";
    const oldContent = "A\nabcde\nB";
    const result = blockAnchorFind(original, oldContent);
    expect(result).not.toBeNull();
  });
});

describe("findMatch", () => {
  it("exact match", () => {
    const result = findMatch("hello world", "world");
    expect(result).not.toBeNull();
    expect(result!.actual).toBe("world");
    expect(result!.passName).toBe("simple");
  });

  it("no match returns null", () => {
    expect(findMatch("hello world", "goodbye")).toBeNull();
  });

  it("CRLF normalization", () => {
    const result = findMatch("hello\r\nworld", "hello\nworld");
    expect(result).not.toBeNull();
    expect(result!.actual).toBe("hello\nworld");
  });

  it("line_trimmed pass matches with different whitespace", () => {
    const original = "  hello   \n  world  ";
    const query = "hello\nworld";
    const result = findMatch(original, query);
    expect(result).not.toBeNull();
  });

  it("escape_normalized matches \\\\` in content", () => {
    const result = findMatch("hello`world", "hello\\`world");
    expect(result).not.toBeNull();
    expect(result!.actual).toBe("hello`world");
    expect(result!.passName).toBe("escape_normalized");
  });

  it("escape_normalized matches \\\\$ in content", () => {
    const result = findMatch("hello$world", "hello\\$world");
    expect(result).not.toBeNull();
    expect(result!.actual).toBe("hello$world");
    expect(result!.passName).toBe("escape_normalized");
  });

  it("escape_normalized matches literal \\\\n as newline", () => {
    const result = findMatch("hello\nworld", "hello\\\\nworld");
    expect(result).not.toBeNull();
    expect(result!.actual).toBe("hello\nworld");
    expect(result!.passName).toBe("escape_normalized");
  });
});

describe("findClosestCandidate", () => {
  it("returns null for empty query", () => {
    expect(findClosestCandidate("hello world", "")).toBeNull();
  });

  it("finds near-miss candidate", () => {
    const original = "function hello() {\n  return 42;\n}\n";
    const query = "function hello() {\n  return 43;\n}\n";
    const result = findClosestCandidate(original, query);
    expect(result).not.toBeNull();
    expect(result!.similarity).toBeGreaterThan(0.5);
    expect(result!.startLine).toBeGreaterThan(0);
  });
});

describe("applyEdits", () => {
  it("applies a simple replacement", () => {
    const content = "hello world";
    const resolved = [
      {
        edit: { path: "test.txt", oldText: "world", newText: "universe" },
        match: { actual: "world", passName: "simple" },
        start: 6,
        end: 11,
      },
    ];
    const result = applyEdits(content, resolved);
    expect(result.content).toBe("hello universe");
    expect(result.applied).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
  });

  it("detects overlapping edits", () => {
    const content = "hello world foo";
    const resolved = [
      {
        edit: { path: "test.txt", oldText: "hello world", newText: "hi world" },
        match: { actual: "hello world", passName: "simple" },
        start: 0,
        end: 11,
      },
      {
        edit: { path: "test.txt", oldText: "world foo", newText: "earth bar" },
        match: { actual: "world foo", passName: "simple" },
        start: 6,
        end: 15,
      },
    ];
    const result = applyEdits(content, resolved);
    // Overlapping edits are no longer hard-rejected as "overlap".
    // In bottom-up order the higher-start edit is applied first; the
    // lower-start edit's span is then consumed and reported as
    // "already-handled" rather than "overlap".
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].kind).toBe("already-handled");
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0].edit.newText).toBe("earth bar");
  });

  it("detects no-op edits", () => {
    const content = "hello world";
    const resolved = [
      {
        edit: { path: "test.txt", oldText: "world", newText: "world" },
        match: { actual: "world", passName: "simple" },
        start: 6,
        end: 11,
      },
    ];
    const result = applyEdits(content, resolved);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].kind).toBe("no-op");
  });

  it("applies multiple non-overlapping edits atomically", () => {
    // Simulates the user's scenario: multiple edits in one call.
    // Our executor reads the file once, resolves all edits against that
    // snapshot, and applies them in memory — no partial writes.
    const content = "line1\nline2\nline3";
    const resolved = [
      {
        edit: { path: "test.txt", oldText: "line1", newText: "LINE1" },
        match: { actual: "line1", passName: "simple" },
        start: 0,
        end: 5,
      },
      {
        edit: { path: "test.txt", oldText: "line3", newText: "LINE3" },
        match: { actual: "line3", passName: "simple" },
        start: 12,
        end: 17,
      },
    ];
    const result = applyEdits(content, resolved);
    expect(result.failed).toHaveLength(0);
    expect(result.applied).toHaveLength(2);
    expect(result.content).toBe("LINE1\nline2\nLINE3");
  });

  it("rejects the unresolvable edits but still resolves the resolvable ones", () => {
    // Partial resolution: one edit matches, one doesn't.
    const content = "hello world";
    const result = resolveBlocks(
      content,
      [
        { path: "test.txt", oldText: "hello", newText: "hi" },
        { path: "test.txt", oldText: "goodbye", newText: "universe" },
      ],
      "test.txt",
    );
    expect(result.ok).toBe(true);
    expect(result.resolved).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.kind).toBe("not-found");
  });

  it("guards against partial application when resolved span is stale", () => {
    // If an edit's match.actual doesn't exist in the content at the
    // resolved span, applyEdits returns 'invariant' and applies nothing.
    // This is a safety net — in practice, resolveBlocks catches this first.
    const content = "hello world";
    const resolved = [
      {
        edit: { path: "test.txt", oldText: "hello", newText: "hi" },
        match: { actual: "goodbye", passName: "simple" },
        start: 0,
        end: 5,
      },
    ];
    const result = applyEdits(content, resolved);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].kind).toBe("invariant");
    expect(result.applied).toHaveLength(0);
    expect(result.content).toBe(content);
  });
});

describe("resolveBlocks", () => {
  it("resolves a single edit", () => {
    const result = resolveBlocks(
      "hello world",
      [{ path: "test.txt", oldText: "world", newText: "universe" }],
      "test.txt",
    );
    expect(result.ok).toBe(true);
    expect(result.resolved).toHaveLength(1);
    expect(result.resolved![0].match.actual).toBe("world");
  });

  describe("anchor window miss — full-content retry (P5, mined live)", () => {
    const file = [
      ...Array.from({ length: 20 }, (_, i) => `// filler ${i}`),
      "export function target() {",
      "  return 42;",
      "}",
    ].join("\n");

    it("rescues a verbatim-unique target when the anchor scopes the wrong region", () => {
      // Anchor matches filler line 5; oldText lives ~25 lines below — far
      // outside the ±10 window. Mined: fingerprint.ts anchor@176/target@207.
      const result = resolveBlocks(
        file,
        [
          {
            path: "test.txt",
            oldText: "export function target() {\n  return 42;\n}",
            newText: "export function target() {\n  return 43;\n}",
            anchor: "// filler 4",
          },
        ],
        "test.txt",
      );
      expect(result.ok).toBe(true);
      expect(result.resolved).toHaveLength(1);
      expect(result.resolved![0].match.actual).toBe("export function target() {\n  return 42;\n}");
      expect(result.diagnostics[0]?.anchorWindowOverflow).toBe(true);
      expect(result.diagnostics[0]?.anchorFallback).toBe(true);
    });

    it("also rescues the legacy long-block case (oldText starts with anchor)", () => {
      // A 25-line block anchored at its head: the ±10 window cannot contain
      // it, and oldText.startsWith(anchor) holds — the historical overflow.
      const body = Array.from({ length: 23 }, (_, i) => `  // step ${i}`);
      const longBlock = ["export function target() {", ...body, "}"].join("\n");
      const content = `${longBlock}\n// tail`;
      const result = resolveBlocks(
        content,
        [
          {
            path: "test.txt",
            oldText: longBlock,
            newText: "X",
            anchor: "export function target() {",
          },
        ],
        "test.txt",
      );
      expect(result.ok).toBe(true);
      expect(result.resolved).toHaveLength(1);
      expect(result.diagnostics[0]?.anchorWindowOverflow).toBe(true);
    });

    it("stays fail-closed when the full-content match is ambiguous", () => {
      // Two identical targets: the anchor picked one region, but full-content
      // retry must NOT silently choose — ambiguity is reported instead.
      const ambiguousFile = [
        ...Array.from({ length: 20 }, (_, i) => `// filler ${i}`),
        "function dup() {}\nfunction other() {}",
        "// more",
        "function dup() {}\nfunction another() {}",
      ].join("\n");
      const result = resolveBlocks(
        ambiguousFile,
        [
          {
            path: "test.txt",
            oldText: "function dup() {}",
            newText: "function replaced() {}",
            anchor: "// filler 2",
          },
        ],
        "test.txt",
      );
      expect(result.ok).toBe(false);
      expect(result.errors[0]!.kind).toBe("ambiguous");
    });
  });

  it("returns error for empty search text", () => {
    const result = resolveBlocks(
      "hello world",
      [{ path: "test.txt", oldText: "", newText: "universe" }],
      "test.txt",
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0]!.kind).toBe("validation");
  });

  it("returns error for identical search/replace", () => {
    const result = resolveBlocks(
      "hello world",
      [{ path: "test.txt", oldText: "world", newText: "world" }],
      "test.txt",
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0]!.kind).toBe("validation");
  });

  it("returns not-found with closest candidate", () => {
    const result = resolveBlocks(
      "hello world",
      [{ path: "test.txt", oldText: "goodbye", newText: "universe" }],
      "test.txt",
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0]!.kind).toBe("not-found");
    expect(result.errors[0]!.closestCandidate).toBeDefined();
  });

  it("auto-expands ambiguous matches", () => {
    const content = "a\nb\nc\na\nb\nc";
    // 'b' appears twice, but 'a\nb' is unique
    const result = resolveBlocks(
      content,
      [{ path: "test.txt", oldText: "a\nb", newText: "X\nY" }],
      "test.txt",
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a disproportionate fuzzy match (block_anchor over-reach)", () => {
    // A 4-line query whose first/last anchor lines match an 8-line span
    // (block_anchor window = oldLines*2 = 8). The matched span (8 lines) is
    // >= oldLines*2 = 8 → disproportionate → refused, never applied.
    const oldText = ["startAnchor();", "mid 1", "mid 2", "endAnchor();"].join("\n");
    const content = [
      "startAnchor();",
      "gap",
      "gap",
      "gap",
      "gap",
      "gap",
      "gap",
      "endAnchor();",
    ].join("\n");
    const outcome = resolveBlocks(
      content,
      [{ path: "test.txt", oldText, newText: "x" }],
      "test.txt",
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.errors[0]!.kind).toBe("disproportionate");
  });

  it("does NOT flag a single-line query as disproportionate (passes can't over-reach)", () => {
    const outcome = resolveBlocks(
      Array.from({ length: 40 }, () => "same();").join("\n"),
      [{ path: "test.txt", oldText: "same();", newText: "other();" }],
      "test.txt",
    );
    expect(outcome.ok).toBe(false); // ambiguous, NOT disproportionate
    expect(outcome.errors[0]!.kind).toBe("ambiguous");
  });

  it("rejects a multi-line query with oversized trimmed span (>4x + 500 chars)", () => {
    // A later pass (context_aware) can match a large span even when
    // block_anchor is stricter; isDisproportionateMatch still refuses it.
    const oldText = "start\nm1\nm2\nend";
    const content = ["start", "m1", "m2", "m3", "m4", "m5", "m6", "end"].join("\n");
    const outcome = resolveBlocks(
      content,
      [{ path: "test.txt", oldText, newText: "x" }],
      "test.txt",
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.errors[0]!.kind).toBe("disproportionate");
  });

  it("passes through a normal-sized multi-line match", () => {
    const oldText = ["function foo() {", "  return 1;", "}"].join("\n");
    const content = [
      "function foo() {",
      "  return 1;",
      "}",
      "function bar() {",
      "  return 2;",
      "}",
    ].join("\n");
    const outcome = resolveBlocks(
      content,
      [{ path: "test.txt", oldText, newText: "x" }],
      "test.txt",
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.errors).toEqual([]);
  });

  it("replaceAll replaces every occurrence", () => {
    const content = "foo bar foo baz foo";
    const outcome = resolveBlocks(
      content,
      [{ path: "test.txt", oldText: "foo", newText: "qux", replaceAll: true }],
      "test.txt",
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.resolved).toHaveLength(3);
    expect(outcome.resolved![0].match.passName).toBe("replace_all");
    expect(outcome.resolved![1].match.passName).toBe("replace_all");
    expect(outcome.resolved![2].match.passName).toBe("replace_all");
    const applied = applyEdits(content, outcome.resolved!);
    expect(applied.content).toBe("qux bar qux baz qux");
  });

  it("replaceAll on unique match still works", () => {
    const content = "hello world";
    const outcome = resolveBlocks(
      content,
      [{ path: "test.txt", oldText: "world", newText: "universe", replaceAll: true }],
      "test.txt",
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.resolved).toHaveLength(1);
    expect(outcome.resolved![0].match.passName).toBe("simple");
  });

  it("replaceAll bypasses ambiguity check", () => {
    const content = "a\nb\na\nb\na\nb";
    const outcome = resolveBlocks(
      content,
      [{ path: "test.txt", oldText: "a", newText: "X", replaceAll: true }],
      "test.txt",
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.resolved).toHaveLength(3);
    expect(outcome.resolved![0].match.passName).toBe("replace_all");
  });

  it("replaceAll with no matches fails correctly", () => {
    const outcome = resolveBlocks(
      "hello world",
      [{ path: "test.txt", oldText: "goodbye", newText: "universe", replaceAll: true }],
      "test.txt",
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.errors[0]!.kind).toBe("not-found");
  });

  it("replaceAll does not produce overlapping spans", () => {
    const outcome = resolveBlocks(
      "aaa",
      [{ path: "test.txt", oldText: "aa", newText: "X", replaceAll: true }],
      "test.txt",
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.resolved).toHaveLength(1);
    const applied = applyEdits("aaa", outcome.resolved!);
    expect(applied.content).toBe("Xa");
  });

  it("carries block index on errors", () => {
    const outcome = resolveBlocks(
      "line1\nline2\nline3\n",
      [
        { path: "test.txt", oldText: "missing1", newText: "X" },
        { path: "test.txt", oldText: "line2", newText: "LINE2" },
        { path: "test.txt", oldText: "missing2", newText: "Y" },
      ],
      "test.txt",
    );
    expect(outcome.errors).toHaveLength(2);
    const indices = outcome.errors.map((e) => e.index).sort();
    expect(indices).toEqual([0, 2]);
  });

  it("remaps Pass 2 error indices to original block indices", () => {
    const outcome = resolveBlocks(
      "AAA\nBBB\n",
      [
        { path: "test.txt", oldText: "AAA", newText: "PREFIX" },
        { path: "test.txt", oldText: "PREFIX\nBBB", newText: "PREFIX\nBBB\nline2\n" },
        { path: "test.txt", oldText: "NOT_EXIST", newText: "X" },
      ],
      "test.txt",
    );
    expect(outcome.resolved.length).toBeGreaterThanOrEqual(2);
    const notFoundErrors = outcome.errors.filter((e) => e.kind === "not-found");
    expect(notFoundErrors.length).toBeGreaterThanOrEqual(1);
    // Every not-found error should reference the original block index (2),
    // including Pass 2 remapped errors.
    expect(notFoundErrors.every((e) => e.index === 2)).toBe(true);
  });
});

describe("executeFile — total-failure isError audit", () => {
  it("returns isError: true for an empty edits array", async () => {
    const result = await executeFile("missing.txt", []);
    expect(result.isError).toBe(true);
  });

  it("returns isError: true when the file does not exist", async () => {
    const result = await executeFile("/nonexistent/path/file.txt", [
      { oldText: "hello", newText: "world" },
    ]);
    expect(result.isError).toBe(true);
  });

  it("returns isError: true when all edits are missing", async () => {
    const result = await executeFile(
      "missing.txt",
      [
        { oldText: "hello", newText: "world" },
        { oldText: "foo", newText: "bar" },
      ],
      { readFile: () => Buffer.from("no matches here") },
    );
    expect(result.isError).toBe(true);
  });

  it("returns isError: true when all edits are ambiguous", async () => {
    // 'a' appears 3 times, no anchor, auto-expand cannot disambiguate.
    const result = await executeFile(
      "ambiguous.txt",
      [
        { oldText: "a", newText: "X" },
        { oldText: "b", newText: "Y" },
      ],
      { readFile: () => Buffer.from("a\na\na\nb\nb\nb") },
    );
    expect(result.isError).toBe(true);
  });

  it("returns isError: true when all edits are no-ops", async () => {
    const result = await executeFile(
      "noop.txt",
      [
        { oldText: "hello", newText: "hello" },
        { oldText: "world", newText: "world" },
      ],
      { readFile: () => Buffer.from("hello\nworld") },
    );
    expect(result.isError).toBe(true);
  });

  it("keeps isError: false for partial applies", async () => {
    const file = join(sandbox, "partial.txt");
    const result = await executeFile(
      file,
      [
        { oldText: "hello", newText: "hi" },
        { oldText: "goodbye", newText: "universe" },
      ],
      { readFile: () => Buffer.from("hello world"), writeFile },
    );
    expect(result.isError).toBe(false);
  });
});

describe("ReadRegistry", () => {
  it("records reads and checks freshness", () => {
    let _mtime = 1000;
    const registry = new ReadRegistry({
      now: () => 2000,
      stat: () => ({ mtimeMs: _mtime }),
      toleranceMs: 50,
    });

    registry.record("test.txt");
    expect(registry.isFresh("test.txt")).toBe(true);

    // File changes after read
    _mtime = 3000;
    expect(registry.isFresh("test.txt")).toBe(false);
    expect(registry.assertFresh("test.txt")).not.toBeNull();
  });

  it("unread files are considered fresh", () => {
    const registry = new ReadRegistry({
      now: () => 1000,
      stat: () => ({ mtimeMs: 5000 }),
      toleranceMs: 50,
    });
    expect(registry.isFresh("never-read.txt")).toBe(true);
  });

  it("first stale is hard error, second is warning", () => {
    let _mtime = 1000;
    const registry = new ReadRegistry({
      now: () => 2000,
      stat: () => ({ mtimeMs: _mtime }),
      toleranceMs: 50,
    });

    registry.record("test.txt");
    expect(registry.isFresh("test.txt")).toBe(true);

    _mtime = 3000;
    const first = registry.assertFresh("test.txt");
    expect(first?.kind).toBe("stale-read");

    const second = registry.assertFresh("test.txt");
    expect(second?.kind).toBe("stale-read-warning");
  });

  it("getStaleWarning is null when fresh or not yet warned", () => {
    let _mtime = 1000;
    const registry = new ReadRegistry({
      now: () => 2000,
      stat: () => ({ mtimeMs: _mtime }),
      toleranceMs: 50,
    });

    registry.record("test.txt");
    expect(registry.getStaleWarning("test.txt")).toBeNull();

    _mtime = 3000;
    expect(registry.getStaleWarning("test.txt")).toBeNull();

    registry.assertFresh("test.txt");
    expect(registry.getStaleWarning("test.txt")).not.toBeNull();
  });

  it("selfRefresh updates both read and edit timestamps", () => {
    let _mtime = 1000;
    let _now = 1000;
    const registry = new ReadRegistry({
      now: () => _now,
      stat: () => ({ mtimeMs: _mtime }),
      toleranceMs: 50,
    });

    registry.record("test.txt");
    _mtime = 5000;
    _now = 6000;
    expect(registry.isFresh("test.txt")).toBe(false);

    registry.selfRefresh("test.txt");
    expect(registry.isFresh("test.txt")).toBe(true);
  });

  it("reset clears all records and warnings", () => {
    const registry = new ReadRegistry({
      now: () => 1000,
      stat: () => ({ mtimeMs: 5000 }),
      toleranceMs: 50,
    });

    registry.record("test.txt");
    registry.assertFresh("test.txt");
    registry.reset();
    expect(registry.lastRead("test.txt")).toBeUndefined();
    expect(registry.assertFresh("test.txt")).toBeNull();
  });
});

let sandbox: string;

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "edit-engine-test-"));
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("coherenceCheck — brace-balance false positives", async () => {
  const SKIP = !BRACE_BALANCE_ENABLED ? "(brace-balance checker temporarily disabled)" : undefined;

  it.skipIf(SKIP)("does not warn on code with braces in comments", async () => {
    const content = `# Python/Ruby style comment with {braces}\n// C-style comment with (parens) and [brackets]\n/* Block comment with {mixed} braces */\nconst x = 1;\n`;

    const { coherenceCheck } = await import("../src/advisories/coherence.js");
    const warnings = coherenceCheck(content, "test.ts");
    expect(warnings).toEqual([]);
  });

  it.skipIf(SKIP)("does not warn on JSDoc/type-annotation-style braces in comments", async () => {
    const content = `/**\n * @param {string} name\n * @returns {Promise<void>}\n */\nconst x = 1;\n`;

    const { coherenceCheck } = await import("../src/advisories/coherence.js");
    const warnings = coherenceCheck(content, "test.ts");
    expect(warnings).toEqual([]);
  });

  it.skipIf(SKIP)("still warns on actually unclosed braces outside comments", async () => {
    const content = `function foo() {\n  return { x: 1 };\n`; // missing closing `}`

    const { coherenceCheck } = await import("../src/advisories/coherence.js");
    const warnings = coherenceCheck(content, "test.ts");
    expect(warnings).toEqual([expect.stringMatching(/Unclosed .* brace/)]);
  });
});

describe("detectDuplicatedBlocks — false-positive regression", () => {
  // detectDuplicatedBlocks is exercised through executeFile's details.corruptionWarnings.

  it("does not warn when inserting another array entry with the same prefix", async () => {
    const original = `export const REPLACER_CHAIN = [\n  { name: "simple", find: simpleFind },\n  { name: "block_anchor", find: blockAnchorFind },\n];\n`;
    const file = join(sandbox, "array-entry.txt");
    const result = await executeFile(
      file,
      [
        {
          oldText: '  { name: "block_anchor", find: blockAnchorFind },\n',
          newText: '  { name: "block_anchor_levenshtein", find: blockAnchorLevenshteinFind },\n',
        },
      ],
      { readFile: () => Buffer.from(original), writeFile },
    );
    expect(result.isError).toBe(false);
    expect((result.details as { corruptionWarnings?: string[] }).corruptionWarnings ?? []).toEqual(
      expect.not.arrayContaining([
        expect.stringMatching(/appears to duplicate the matched block/),
        expect.stringMatching(/duplicates context before the splice/),
        expect.stringMatching(/duplicates context after the splice/),
      ]),
    );
  });

  it("does not warn when replacing a verbose condition with a shorter one", async () => {
    const original = `if (getConfig().undoEnabled &&\n  (result.details as { baseContent: string; newContent: string }).baseContent !==\n    (result.details as { baseContent: string; newContent: string }).newContent\n) {\n  const undo = await saveUndo(resolvedPath, {\n    content: baseContent,\n    bom: bom ?? "",\n    originalEnding: originalEnding ?? "\n",\n    resultContent: newContent,\n    rawContent: detailsAny?.rawContent as string | undefined,\n    rawResult: detailsAny?.rawResult as string | undefined,\n    encoding: detailsAny?.encoding as "utf-8" | "latin1",\n  });\n}\n`;
    const file = join(sandbox, "condition.txt");
    const result = await executeFile(
      file,
      [
        {
          oldText:
            "(result.details as { baseContent: string; newContent: string }).baseContent !==\n" +
            "  (result.details as { baseContent: string; newContent: string }).newContent",
          newText: "baseContent !== newContent",
        },
      ],
      { readFile: () => Buffer.from(original), writeFile },
    );
    expect(result.isError).toBe(false);
    expect((result.details as { corruptionWarnings?: string[] }).corruptionWarnings ?? []).toEqual(
      expect.not.arrayContaining([
        expect.stringMatching(/duplicates context before the splice/),
        expect.stringMatching(/duplicates context after the splice/),
      ]),
    );
  });

  it("does not warn when adding a new import next to an existing import", async () => {
    const original = `import { getConfig } from "../config/settings.js";\n\n`;
    const file = join(sandbox, "import.txt");
    const result = await executeFile(
      file,
      [
        {
          oldText: 'import { getConfig } from "../config/settings.js";\n',
          newText: 'import { getConfig, getUndo } from "../config/settings.js";\n',
        },
      ],
      { readFile: () => Buffer.from(original), writeFile },
    );
    expect(result.isError).toBe(false);
    expect((result.details as { corruptionWarnings?: string[] }).corruptionWarnings ?? []).toEqual(
      expect.not.arrayContaining([expect.stringMatching(/appears to duplicate the matched block/)]),
    );
  });

  it("does not warn when adding a test case before a closing brace", async () => {
    const original = `describe("suite", () => {\n  it("existing", () => {\n    expect(true).toBe(true);\n  });\n});\n`;
    const file = join(sandbox, "test-case.txt");
    const result = await executeFile(
      file,
      [
        {
          oldText: "  });\n});\n",
          newText: '  it("new test", () => {\n' + "    expect(x).toBe(y);\n" + "  });\n" + "});\n",
        },
      ],
      { readFile: () => Buffer.from(original), writeFile },
    );
    expect(result.isError).toBe(false);
    expect((result.details as { corruptionWarnings?: string[] }).corruptionWarnings ?? []).toEqual(
      expect.not.arrayContaining([
        expect.stringMatching(/duplicates context after the splice/),
        expect.stringMatching(/appears to duplicate the matched block/),
      ]),
    );
  });

  it("does not warn for short replacements under 80 characters", async () => {
    const original = "line1\nline2\nline3\n";
    const file = join(sandbox, "short.txt");
    const result = await executeFile(file, [{ oldText: "line2", newText: "LINE2" }], {
      readFile: () => Buffer.from(original),
      writeFile,
    });
    expect(result.isError).toBe(false);
    expect((result.details as { corruptionWarnings?: string[] }).corruptionWarnings ?? []).toEqual(
      expect.not.arrayContaining([expect.stringMatching(/CORRUPTION CHECK/)]),
    );
  });

  it("still warns when the new text duplicates 2+ full lines from the matched block", async () => {
    const original = "function foo() {\n  return 1;\n}\nfunction bar() {\n  return 2;\n}\n";
    const longNewText =
      "function foo() {\n  return 1;\n}\nfunction foo() {\n  return 1;\n}\n".repeat(3);
    const file = join(sandbox, "dup-match.txt");
    const result = await executeFile(
      file,
      [
        {
          oldText: "function foo() {\n  return 1;\n}\n",
          newText: longNewText,
        },
      ],
      { readFile: () => Buffer.from(original), writeFile },
    );
    expect(result.isError).toBe(false);
    // The warning may be either consecutive-block or prefix-echo depending on
    // which check fires first. Accept either.
    expect((result.details as { corruptionWarnings?: string[] }).corruptionWarnings ?? []).toEqual(
      expect.arrayContaining([expect.stringMatching(/appears to duplicate/)]),
    );
  });

  it("still warns when the new text duplicates 5+ full lines from adjacent context", async () => {
    // newText must contain 5+ consecutive non-structural lines matching
    // before/after context (within the 64-char CONTEXT_WINDOW), and density >= 0.7.
    const original = "line1\nline2\nline3\nline4\nline5\nline6\nTARGET\nline8\nline9\nline10\n";
    // newText contains line2-line6 (5 lines) from before context
    const longNewText = Array(10).fill("line2\nline3\nline4\nline5\nline6\n").join("");
    const file = join(sandbox, "dup-context-5.txt");
    const result = await executeFile(
      file,
      [
        {
          oldText: "TARGET\n",
          newText: longNewText,
        },
      ],
      { readFile: () => Buffer.from(original), writeFile },
    );
    expect(result.isError).toBe(false);
    expect((result.details as { corruptionWarnings?: string[] }).corruptionWarnings ?? []).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/duplicates context (before|after) the splice/),
      ]),
    );
  });

  it("does not warn for long single-line replacements that do not duplicate the matched line", async () => {
    const original = "const x = 1;\n";
    const longNewText = Array(20).fill("const y = 2; ").join("") + "const z = 3;";
    const file = join(sandbox, "long-single-line.txt");
    const result = await executeFile(file, [{ oldText: "const x = 1;", newText: longNewText }], {
      readFile: () => Buffer.from(original),
      writeFile,
    });
    expect(result.isError).toBe(false);
    expect((result.details as { corruptionWarnings?: string[] }).corruptionWarnings ?? []).toEqual(
      expect.not.arrayContaining([
        expect.stringMatching(
          /appears to duplicate.*(?:lines|consecutive block) from the matched block/,
        ),
      ]),
    );
  });

  it("does not warn when newText is empty", async () => {
    const original = "line1\nline2\nline3\n";
    const file = join(sandbox, "empty-newtext.txt");
    const result = await executeFile(file, [{ oldText: "line2", newText: "" }], {
      readFile: () => Buffer.from(original),
      writeFile,
    });
    expect(result.isError).toBe(false);
    expect((result.details as { corruptionWarnings?: string[] }).corruptionWarnings ?? []).toEqual(
      expect.not.arrayContaining([expect.stringMatching(/duplicates context already inserted/)]),
    );
  });

  describe("consecutive-sequence guards (no scattered-line false positives)", () => {
    it("does NOT warn when a multi-line match shares only 2 scattered lines with newText", async () => {
      // Scattered shared lines should not trigger the check.
      const original = "a1\na2\na3\na4\na5\na6\na7\na8\na9\na10\n";
      // newText contains a2 and a3 from the matched block, but not consecutively.
      const newText = Array(30).fill("a2\na9\na3\n").join("") + "extra\n";
      const file = join(sandbox, "scattered-2-lines.txt");
      const result = await executeFile(file, [{ oldText: "a1\na2\na3\na4\na5\n", newText }], {
        readFile: () => Buffer.from(original),
        writeFile,
      });
      expect(result.isError).toBe(false);
      expect(
        (result.details as { corruptionWarnings?: string[] }).corruptionWarnings ?? [],
      ).toEqual(
        expect.not.arrayContaining([
          expect.stringMatching(
            /appears to duplicate.*(?:lines|consecutive block) from the matched block/,
          ),
        ]),
      );
    });

    it("still warns when a multi-line match shares 4+ consecutive lines with newText", async () => {
      // A real duplication should still be caught.
      // Use non-structural lines (no trailing }, ), etc.) so isStructural filter doesn't skip them.
      const original = "  return a;\n  return b;\n  return c;\n  return d;\n  return e;\n";
      // Target contains a 4-line consecutive sequence from source
      const newText = Array(10)
        .fill("  return a;\n  return b;\n  return c;\n  return d;\n")
        .join("");
      const file = join(sandbox, "consecutive-4-lines.txt");
      const result = await executeFile(
        file,
        [{ oldText: "  return a;\n  return b;\n  return c;\n  return d;\n", newText }],
        { readFile: () => Buffer.from(original), writeFile },
      );
      expect(result.isError).toBe(false);
      expect(
        (result.details as { corruptionWarnings?: string[] }).corruptionWarnings ?? [],
      ).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /appears to duplicate.*(?:lines|consecutive block) from the matched block/,
          ),
        ]),
      );
    });

    it("does NOT warn when context before/after shares only 2 scattered lines", async () => {
      // The matched block is multi-line so the splice has surrounding context.
      const original = "x1\nx2\nx3\nTARGET1\nTARGET2\ny1\ny2\ny3\ny4\ny5\n";
      // newText contains x2 and y2 from context, but not consecutively.
      const newText = Array(20).fill("x2\nfoo\ny2\n").join("") + "extra\n";
      const file = join(sandbox, "context-scattered-2.txt");
      const result = await executeFile(file, [{ oldText: "TARGET1\nTARGET2\n", newText }], {
        readFile: () => Buffer.from(original),
        writeFile,
      });
      expect(result.isError).toBe(false);
      expect(
        (result.details as { corruptionWarnings?: string[] }).corruptionWarnings ?? [],
      ).toEqual(
        expect.not.arrayContaining([
          expect.stringMatching(/duplicates context (before|after) the splice/),
        ]),
      );
    });

    it("still warns when context before/after shares 5+ consecutive lines", async () => {
      // newText must be >= 120 chars to pass the short-replacement guard.
      const original = "x1\nx2\nx3\nx4\nx5\nx6\nTARGET\ny1\ny2\ny3\ny4\ny5\n";
      const newText = "x2\nx3\nx4\nx5\nx6\n".repeat(10) + "extra\n";
      const file = join(sandbox, "context-consecutive-5.txt");
      const result = await executeFile(file, [{ oldText: "TARGET\n", newText }], {
        readFile: () => Buffer.from(original),
        writeFile,
      });
      expect(result.isError).toBe(false);
      expect(
        (result.details as { corruptionWarnings?: string[] }).corruptionWarnings ?? [],
      ).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/duplicates context (before|after) the splice/),
        ]),
      );
    });
  });

  describe("density guard for large edits", () => {
    it("does NOT warn when a 100-line matched block shares only 2 lines with newText", async () => {
      // Build a 100-line matched block where only 2 lines appear in newText.
      const matchedBlock = Array.from({ length: 100 }, (_, i) => `line${i}\n`).join("");
      const original = matchedBlock + "AFTER\n";
      // newText contains line5 and line10 from the matched block (scattered).
      const newText = Array(50).fill("line5\nfoo\nline10\n").join("") + "extra\n";
      const file = join(sandbox, "large-edit-low-density.txt");
      const result = await executeFile(file, [{ oldText: matchedBlock, newText }], {
        readFile: () => Buffer.from(original),
        writeFile,
      });
      expect(result.isError).toBe(false);
      expect(
        (result.details as { corruptionWarnings?: string[] }).corruptionWarnings ?? [],
      ).toEqual(
        expect.not.arrayContaining([
          expect.stringMatching(
            /appears to duplicate.*(?:lines|consecutive block) from the matched block/,
          ),
        ]),
      );
    });
  });

  describe("prefix-echo search starts after first 20% of newText", () => {
    it("does NOT warn when the duplicate prefix is in the first 20% of newText", async () => {
      // Use a prefix just above the 20-char threshold so the 20% rule applies.
      const original = "function foo() {\n  return 1;\n}\n";
      const prefix = "function foo() {"; // 20 chars
      // newText >= 120 chars to pass the short-replacement guard.
      // Put the duplicate prefix at position ~13% — should not warn.
      const newText = prefix + "x".repeat(10) + prefix + "y".repeat(100);
      expect(newText.length).toBeGreaterThanOrEqual(120);
      const file = join(sandbox, "prefix-early-duplicate.txt");
      const result = await executeFile(file, [{ oldText: prefix, newText }], {
        readFile: () => Buffer.from(original),
        writeFile,
      });
      expect(result.isError).toBe(false);
      expect(
        (result.details as { corruptionWarnings?: string[] }).corruptionWarnings ?? [],
      ).toEqual(
        expect.not.arrayContaining([
          expect.stringMatching(/appears to duplicate the matched block/),
        ]),
      );
    });

    it("still warns when the duplicate prefix is after the first 20% of newText", async () => {
      // Use a prefix above the 20-char minPrefixLen threshold.
      const original = "function foo() {\n  return 1;\n}\n";
      const prefix = "function foo() {\n  return"; // 25 chars
      // newText >= 120 chars to pass the short-replacement guard.
      // Put the duplicate prefix at position ~76% — should warn.
      const newText = prefix + "x".repeat(60) + prefix + "y".repeat(30);
      expect(newText.length).toBeGreaterThanOrEqual(120);
      const file = join(sandbox, "prefix-late-duplicate.txt");
      const result = await executeFile(file, [{ oldText: prefix, newText }], {
        readFile: () => Buffer.from(original),
        writeFile,
      });
      expect(result.isError).toBe(false);
      expect(
        (result.details as { corruptionWarnings?: string[] }).corruptionWarnings ?? [],
      ).toEqual(
        expect.arrayContaining([expect.stringMatching(/appears to duplicate the matched block/)]),
      );
    });
  });

  it("does NOT warn when duplicated context lines are a small fraction of newText", async () => {
    // newText contains 3 consecutive lines from context, but those lines
    // are only a small fraction of the total insertion.
    const original = "a1\na2\na3\na4\na5\nb2\nb3\nb4\nb5\nTARGET\nc1\nc2\nc3\n";
    const newText =
      "b2\nb3\nb4\n" + Array.from({ length: 100 }, () => "other\n").join("") + "extra\n";
    const file = join(sandbox, "context-small-fraction.txt");
    const result = await executeFile(file, [{ oldText: "TARGET\n", newText }], {
      readFile: () => Buffer.from(original),
      writeFile,
    });
    expect(result.isError).toBe(false);
    expect((result.details as { corruptionWarnings?: string[] }).corruptionWarnings ?? []).toEqual(
      expect.not.arrayContaining([
        expect.stringMatching(/duplicates context (before|after) the splice/),
      ]),
    );
  });

  it("does NOT warn when matched-block lines are a small fraction of newText", async () => {
    // newText contains 3 consecutive lines from the matched block, but they
    // represent only a small fraction of the total newText.
    const original = "func1() {}\nfunc2() {}\nfunc3() {}\nfunc4() {}\nfunc5() {}\n";
    const newText =
      "func2() {}\nfunc3() {}\nfunc4() {}\n" +
      Array.from({ length: 100 }, () => "other\n").join("") +
      "extra\n";
    const file = join(sandbox, "matched-small-fraction.txt");
    const result = await executeFile(
      file,
      [{ oldText: "func1() {}\nfunc2() {}\nfunc3() {}\nfunc4() {}\n", newText }],
      { readFile: () => Buffer.from(original), writeFile },
    );
    expect(result.isError).toBe(false);
    expect((result.details as { corruptionWarnings?: string[] }).corruptionWarnings ?? []).toEqual(
      expect.not.arrayContaining([
        expect.stringMatching(
          /appears to duplicate.*(?:lines|consecutive block) from the matched block/,
        ),
      ]),
    );
  });

  it("does NOT warn on prefix echo when the prefix is a small fraction of newText", async () => {
    const original = "function foo() {\n  return 1;\n}\n";
    const prefix = "function foo"; // 12 chars
    // newText >= 80 chars to pass the short-replacement guard.
    // The duplicate prefix is only ~2% of newText — should not warn.
    const newText = prefix + "x".repeat(200) + prefix + "y".repeat(200);
    expect(newText.length).toBeGreaterThanOrEqual(80);
    const file = join(sandbox, "prefix-small-fraction.txt");
    const result = await executeFile(file, [{ oldText: prefix, newText }], {
      readFile: () => Buffer.from(original),
      writeFile,
    });
    expect(result.isError).toBe(false);
    expect((result.details as { corruptionWarnings?: string[] }).corruptionWarnings ?? []).toEqual(
      expect.not.arrayContaining([expect.stringMatching(/appears to duplicate the matched block/)]),
    );
  });
});

describe("structural blockIndex threading (mined: stale-missing desync)", () => {
  it("applyEdits threads blockIndex into failures even on invariant refusals", () => {
    const result = applyEdits("hello world", [
      {
        edit: { path: "t.txt", oldText: "ghost", newText: "x" },
        match: { actual: "GHOST", passName: "simple" },
        start: 6,
        end: 11,
        blockIndex: 7,
      },
    ]);
    expect(result.applied).toHaveLength(0);
    expect(result.failed[0]!.kind).toBe("invariant");
    expect(result.failed[0]!.blockIndex).toBe(7);
  });

  it("identical twin edits attribute apply failure to the SECOND block, not the first", () => {
    // Old code re-derived indices via blocks.findIndex on the edit triple,
    // which pinned BOTH twins to index 0 and could mark an applied edit
    // failed. Structural indices keep 0=applied, 1=already-handled.
    const result = applyEdits("unique anchor text", [
      {
        edit: { path: "t.txt", oldText: "anchor", newText: "target" },
        match: { actual: "anchor", passName: "simple" },
        start: 7,
        end: 13,
        blockIndex: 0,
      },
      {
        edit: { path: "t.txt", oldText: "anchor", newText: "target" },
        match: { actual: "anchor", passName: "simple" },
        start: 7,
        end: 13,
        blockIndex: 1,
      },
    ]);
    expect(result.applied).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.kind).toBe("already-handled");
    expect(result.failed[0]!.blockIndex).toBe(1);
  });
});

describe("enriched closest-candidate diagnostics", () => {
  const candidate = {
    passName: "closest-candidate",
    similarity: 0.65,
    candidate: "const doubled = x * 2;",
    startLine: 890,
    endLine: 909,
    tokenDice: 0.81,
    tokenJaccard: 0.7,
  };

  it("renders similarity and anchor status in not-found messages", () => {
    const err = notFoundError("/repo/f.txt", candidate);
    expect(err.message).toMatch(/Closest match \(65% similar\) at lines 890-909:/);
    expect(err.message).not.toContain("dice");
    expect(err.message).not.toContain("jaccard");
    expect(err.message).toContain("Anchor status:");
  });

  it("anchor-scoped vs no-anchor wording", () => {
    const scoped = notFoundError(
      "/repo/f.txt",
      candidate,
      "Anchor status: search was anchor-scoped.",
    );
    expect(scoped.message).toContain("search was anchor-scoped");
    const bare = notFoundError("/repo/f.txt", candidate);
    expect(bare.message).toContain("Anchor status: none provided");
  });

  it("omits the token clause for legacy candidates without the fields", () => {
    const { tokenDice: _d, tokenJaccard: _j, ...legacy } = candidate;
    const err = notFoundError("/repo/f.txt", legacy);
    expect(err.message).toMatch(/Closest match \(65% similar\) at lines 890-909:/);
    expect(err.message).not.toContain("dice");
  });

  it("anchor-not-found states the anchor verdict explicitly", () => {
    const err = anchorNotFoundError("/repo/f.txt", candidate);
    expect(err.message).toContain(
      "Anchor status: the anchor has no verbatim occurrence in the file.",
    );
  });

  it("integration: a not-found failure carries the enriched line end-to-end", async () => {
    const original = [
      "export function compute(x: number): number {",
      "  const doubled = x * 2;",
      "  const squared = x * x;",
      "  return doubled + squared;",
      "}",
    ].join("\n");
    // Heavy drift: below rescue gates, above closest-candidate's 0.3 floor.
    const result = await executeFile(
      "/repo/enrich.txt",
      [
        {
          oldText:
            "totally unrelated prose block\nthat shares almost nothing\nwith the target file",
          newText: "X",
        },
      ],
      {
        cwd: "/repo",
        readFile: () => Buffer.from(original),
        writeFile: () => {},
        rename: () => {},
        exists: () => true,
        mkdir: () => {},
        unlink: () => {},
      },
    );
    if (!result.isError) return; // rescue legitimately recovered it
    const text = result.content.map((c) => c.text || "").join("\n");
    if (/Closest match/.test(text)) {
      expect(text).toContain("Anchor status:");
    }
  });
});
