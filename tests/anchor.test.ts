import { describe, it, expect } from "vitest";
import { resolveBlocks } from "../src/edit/pipeline/resolve.js";
import type { EditError } from "../src/edit/model.js";

const CONTENT = [
  "line 1",
  "def helper():",
  "    return 1",
  "",
  "def target():",
  "    return 2",
  "",
  "def helper():",
  "    return 3",
  "",
  "def target():",
  "    return 4",
].join("\n");

describe("resolveBlocks anchor window (Stage 1.4)", () => {
  it("resolves oldText within the anchor window (±10 lines)", () => {
    const outcome = resolveBlocks(
      CONTENT,
      [
        {
          path: "f.py",
          oldText: "def helper():",
          newText: "def helper2():",
          anchor: "return 4",
        },
      ],
      "f.py",
    );
    expect(outcome.ok).toBe(true);
    // Anchor "return 4" is unique; window covers the SECOND helper() only
    const resolved = outcome.resolved![0]!;
    const before = CONTENT.slice(0, resolved.start);
    expect(before.split("\n").length).toBeGreaterThan(7); // matched past line 7
  });

  it("anchor disambiguates a file-level-ambiguous oldText", () => {
    // Same block duplicated 20 lines apart; the anchor window covers only one.
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    lines[5] = "def dup():";
    lines[25] = "def dup():";
    const tall = lines.join("\n");

    const outcome = resolveBlocks(
      tall,
      [
        {
          path: "f.py",
          oldText: "def dup():",
          newText: "def renamed():",
          anchor: "line 24",
        },
      ],
      "f.py",
    );
    expect(outcome.ok).toBe(true);
    const resolved = outcome.resolved![0]!;
    const startLine = tall.slice(0, resolved.start).split("\n").length; // 1-indexed
    expect(startLine).toBe(26); // the SECOND dup (line 25 0-indexed → line 26 1-indexed), not the first
  });

  it("anchor window makes a far-away duplicate invisible", () => {
    // content with the same block 30 lines apart
    const wide = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
    const wideContent = wide.replace("line 5", "MARKER").replace("line 35", "MARKER");
    const outcome = resolveBlocks(
      wideContent,
      [
        {
          path: "w.txt",
          oldText: "MARKER",
          newText: "X",
          anchor: "line 6", // unique (no "line 6x" lines in 1..40)
        },
      ],
      "w.txt",
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.resolved![0]!.start).toBeLessThan(200); // near the top, not line 35
  });

  it("out-of-window UNIQUE target is rescued by full-content retry (P5)", () => {
    // Mined live (2026-08): anchors identify, they do not scope. When the
    // window misses but oldText is unambiguous at full scope, applying beats
    // aborting — uniqueness guards still run.
    const outcome = resolveBlocks(
      CONTENT,
      [
        {
          path: "f.py",
          oldText: "return 4",
          newText: "return 40",
          anchor: "line 1",
        },
      ],
      "f.py",
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.diagnostics[0]?.anchorWindowOverflow).toBe(true);
  });

  it("window miss + multi-occurrence target stays ambiguous (fail-closed)", () => {
    // Both "def helper():" occurrences lie OUTSIDE the anchor window, so the
    // windowed search misses; full-content retry must refuse to choose
    // between them instead of silently applying to the first.
    const content = [
      "line 1",
      ...Array.from({ length: 12 }, (_, i) => `// pad ${i}`),
      "def helper():",
      "    return 1",
      "// gap",
      "def helper():",
      "    return 2",
    ].join("\n");
    const outcome = resolveBlocks(
      content,
      [
        {
          path: "f.py",
          oldText: "def helper():",
          newText: "def helper2():",
          anchor: "line 1",
        },
      ],
      "f.py",
    );
    expect(outcome.ok).toBe(false);
    expect((outcome.errors[0] as EditError).kind).toBe("ambiguous");
  });

  it("anchor not found → anchor-not-found error", () => {
    const outcome = resolveBlocks(
      CONTENT,
      [
        {
          path: "f.py",
          oldText: "def target():",
          newText: "X",
          anchor: "no such text",
        },
      ],
      "f.py",
    );
    expect(outcome.ok).toBe(false);
    const error = outcome.errors[0] as EditError;
    expect(error.kind).toBe("anchor-not-found");
    expect(error.message).toContain("anchor");
  });

  it("ambiguous anchor → anchor-ambiguous error asking for a distinctive anchor", () => {
    const outcome = resolveBlocks(
      CONTENT,
      [
        {
          path: "f.py",
          oldText: "return 4",
          newText: "X",
          anchor: "def helper():",
        },
      ],
      "f.py",
    );
    expect(outcome.ok).toBe(false);
    const error = outcome.errors[0] as EditError;
    expect(error.kind).toBe("anchor-ambiguous");
    expect(error.linePositions).toHaveLength(2);
  });

  it("locates the anchor with the fuzzy chain (whitespace drift)", () => {
    const drifted = CONTENT.replace("def target():", "def  target():");
    const outcome = resolveBlocks(
      drifted,
      [
        {
          path: "f.py",
          oldText: "def  target():",
          newText: "def target2():",
          anchor: "return 4",
        },
      ],
      "f.py",
    );
    expect(outcome.ok).toBe(true);
  });

  it("replacement applies to verbatim matched text only (safety invariant)", () => {
    const outcome = resolveBlocks(
      CONTENT,
      [
        {
          path: "f.py",
          oldText: "return 2",
          newText: "return 20",
          anchor: "return 2",
        },
      ],
      "f.py",
    );
    expect(outcome.ok).toBe(true);
    const resolved = outcome.resolved![0]!;
    expect(CONTENT.slice(resolved.start, resolved.end)).toBe("return 2");
  });

  it("anchor is optional: no anchor means full-file search (unchanged behavior)", () => {
    const outcome = resolveBlocks(
      CONTENT,
      [{ path: "f.py", oldText: "line 1", newText: "line 1!" }],
      "f.py",
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.resolved![0]!.start).toBe(0);
  });
});
