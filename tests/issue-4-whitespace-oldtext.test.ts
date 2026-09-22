// Regression for issue #4 — unbounded memory growth when a whitespace-only
// oldText has no match.
//
// Root cause: whitespace_normalized (and trimmed_boundary) normalized an
// all-whitespace query to "", which `includes("")` reports as matching every
// position. findMatch then returned `{ actual: "" }`, and reportOccurrences
// called findOccurrencePositions(content, "") — `indexOf("", pos)` always
// returns `pos`, so the scan position never advanced and the positions array
// grew until the process was OOM-killed.
//
// Fixes under test:
//   1. findOccurrencePositions refuses an empty needle outright.
//   2. whitespace_normalized / trimmed_boundary bail on all-whitespace input.
//   3. findMatch / findMatchStrongerThan never accept an empty `actual`.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPiMock, makeCtx, type PiMock } from "../packages/pi-base/src/pi-mock.js";
import { registerEditTool } from "../src/platform/tools/edit.js";
import { findMatch, findOccurrencePositions } from "../src/edit/matching/chain.js";
import {
  whitespaceNormalizedFind,
  trimmedBoundaryFind,
  simpleFind,
} from "../src/edit/matching/passes.js";

type ToolDef = {
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ReturnType<typeof makeCtx>,
  ) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
};

let pi: PiMock;
let tool: ToolDef;
let dir: string;

beforeAll(() => {
  pi = createPiMock();
  registerEditTool(pi as unknown as ExtensionAPI);
  tool = pi.tools[0] as unknown as ToolDef;
  dir = mkdtempSync(join(tmpdir(), "edit-guard-issue4-"));
  process.env.PI_UNDO_STORE_PATH = join(dir, "undo-store.json");
});

afterAll(() => {
  delete process.env.PI_UNDO_STORE_PATH;
  rmSync(dir, { recursive: true, force: true });
});

const ctx = () => makeCtx({ cwd: dir });

function write(name: string, content: string): string {
  const file = join(dir, name);
  writeFileSync(file, content);
  return file;
}

describe("issue #4 — findOccurrencePositions never loops on an empty needle", () => {
  it("returns no positions for an empty needle instead of growing forever", () => {
    // Without the guard this call never returns (the OOM repro).
    expect(findOccurrencePositions("aaa\nbbb\nccc\n", "")).toEqual([]);
    expect(findOccurrencePositions("", "")).toEqual([]);
  });

  it("still reports real occurrences", () => {
    expect(findOccurrencePositions("aaa", "aa")).toEqual([1]);
    expect(findOccurrencePositions("aaa bbb\nccc bbb\n", "bbb")).toEqual([1, 2]);
  });
});

describe("issue #4 — whitespace-only passes never emit an empty match", () => {
  const files = {
    empty: "",
    nospace: "aaa\nbbb\nccc\n",
    longline: "a\n" + "x".repeat(60000) + "\nb\n",
  };

  it("whitespaceNormalizedFind / trimmedBoundaryFind bail on all-whitespace input", () => {
    expect(whitespaceNormalizedFind(files.nospace, " ")).toBeNull();
    expect(trimmedBoundaryFind(files.nospace, " ")).toBeNull();
    expect(whitespaceNormalizedFind(files.nospace, "\t")).toBeNull();
    expect(trimmedBoundaryFind(files.nospace, "\n\n")).toBeNull();
  });

  it("simpleFind rejects the empty query that includes() would 'match'", () => {
    expect(simpleFind(files.nospace, "")).toBeNull();
  });

  it("findMatch returns null for a whitespace needle with no match", () => {
    expect(findMatch(files.empty, " ")).toBeNull();
    expect(findMatch(files.empty, "\t")).toBeNull();
    expect(findMatch(files.empty, "\n")).toBeNull();
    expect(findMatch(files.empty, "\n\n")).toBeNull();
    // nospace/longline DO contain single newlines; only tab, space and
    // blank-line runs are absent.
    expect(findMatch(files.nospace, " ")).toBeNull();
    expect(findMatch(files.nospace, "\t")).toBeNull();
    expect(findMatch(files.nospace, "\n\n")).toBeNull();
    expect(findMatch(files.longline, " ")).toBeNull();
    expect(findMatch(files.longline, "\t")).toBeNull();
    expect(findMatch(files.longline, "\n\n")).toBeNull();
  });

  it("findMatch still matches a whitespace needle that DOES occur (control case)", () => {
    const hit = findMatch("aaa bbb\nccc\n", " ");
    expect(hit).toEqual({ actual: " ", passName: "simple" });
  });
});

describe("issue #4 — edit tool returns instead of exhausting memory", () => {
  it("fails the edit cleanly when oldText is whitespace with no match", async () => {
    const file = write("nospace.txt", "aaa\nbbb\nccc\n");
    await expect(
      tool.execute(
        "call-issue4",
        { path: file, edits: [{ oldText: " ", newText: "first\nsecond\n" }] },
        undefined,
        undefined,
        ctx(),
      ),
    ).rejects.toThrow(/Could not find oldText/);
    expect(readFileSync(file, "utf8")).toBe("aaa\nbbb\nccc\n");
  });

  it("fails cleanly against an empty file without a zero-length match", async () => {
    const file = write("empty.txt", "");
    await expect(
      tool.execute(
        "call-issue4-empty",
        { path: file, edits: [{ oldText: " ", newText: "first\nsecond\n" }] },
        undefined,
        undefined,
        ctx(),
      ),
    ).rejects.toThrow(/Could not find oldText/);
    expect(readFileSync(file, "utf8")).toBe("");
  });
});
