// Stage 2.2 parity tests — the gate for the edit override.
//
// These exercise the registered tool definition end-to-end (prepareArguments
// → execute against real temp files), asserting the native contract:
//   - success text parity: "Successfully replaced N block(s) in path."
//   - details shape: { diff, patch, firstChangedLine } (+ additive guard)
//   - applyPatch(original, details.patch) === new content (round-trip)
//   - fuzzy passes land and passName shows in details.guard
//   - anchor window semantics
//   - thrown error messages contain the closest candidate on a total miss
//   - repair notes appear in result text when args were repaired
//   - killswitch: registration no-ops when editOverrideEnabled is false

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatch } from "diff";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPiMock, makeCtx, type PiMock } from "../packages/pi-base/src/pi-mock.js";
import { registerEditTool } from "../src/platform/tools/edit.js";
import { getConfig } from "../src/config/settings.js";
import { getUndo } from "../src/history/store.js";

type ToolDef = {
  prepareArguments: (args: unknown) => unknown;
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ReturnType<typeof makeCtx>,
  ) => Promise<{
    content: Array<{ type: string; text?: string }>;
    isError?: boolean;
    details: {
      diff?: string;
      patch?: string;
      firstChangedLine?: number;
      guard?: {
        passNames: string[];
        repaired: string[];
        anchorUsed: boolean;
        coherenceWarnings: string[];
      };
    };
  }>;
};

let pi: PiMock;
let tool: ToolDef;
let dir: string;

beforeAll(() => {
  pi = createPiMock();
  registerEditTool(pi as unknown as ExtensionAPI);
  tool = pi.tools[0] as unknown as ToolDef;
  dir = mkdtempSync(join(tmpdir(), "edit-guard-test-"));
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

describe("edit override — native contract parity", () => {
  it("registers a tool named edit with the native prompt metadata", () => {
    expect(pi.tools).toHaveLength(1);
    const registered = pi.tools[0] as { name: string; description: string };
    expect(registered.name).toBe("edit");
    expect(registered.description).toContain("Edit a single file using exact text replacement");
  });

  it("success text + details shape match native (diff/patch/firstChangedLine)", async () => {
    const file = write("a.txt", "line1\nline2\nline3\n");
    const result = await tool.execute(
      "call-1",
      { path: file, edits: [{ oldText: "line2", newText: "LINE2" }] },
      undefined,
      undefined,
      ctx(),
    );

    expect(result.isError).toBeUndefined();
    // Native-message parity: first line is exactly the native success text
    // (additive lines — repair notes / matches / warnings — may follow).
    expect(result.content[0]?.text?.split("\n")[0]).toBe(
      `Successfully replaced 1 block(s) in ${file}.`,
    );
    expect(result.content[0]?.text).toContain("Applied: 1 | Failed: 0 | Skipped: 0");
    expect(typeof result.details.diff).toBe("string");
    expect(result.details.diff!.length).toBeGreaterThan(0);
    expect(typeof result.details.patch).toBe("string");
    expect(result.details.patch!.length).toBeGreaterThan(0);
    expect(result.details.firstChangedLine).toBe(2);
    // additive guard block
    expect(result.details.guard).toMatchObject({
      passNames: ["simple"],
      anchorUsed: false,
      coherenceWarnings: [],
    });
    // file actually written
    expect(readFileSync(file, "utf8")).toBe("line1\nLINE2\nline3\n");
  });

  it("details.patch round-trips through applyPatch", async () => {
    const original = "alpha\nbeta\ngamma\ndelta\n";
    const file = write("roundtrip.txt", original);
    const result = await tool.execute(
      "call-2",
      {
        path: file,
        edits: [
          { oldText: "beta", newText: "BETA" },
          { oldText: "delta", newText: "DELTA" },
        ],
      },
      undefined,
      undefined,
      ctx(),
    );

    expect(result.isError).toBeUndefined();
    const applied = applyPatch(original, result.details.patch as string);
    expect(applied).toBe("alpha\nBETA\ngamma\nDELTA\n");
  });

  it("fuzzy passes land and report their passName in guard", async () => {
    const cases: Array<[string, string, string, string]> = [
      // [file content, oldText, expected pass, newText marker]
      // Pass 2 (indentation mismatch) autopatches the leading-space drift
      // before the match chain runs, so the exact match lands on `simple`.
      ["  hello   \n  world  \n", "hello\nworld", "simple", "HELLO"],
      ["café — done\n", "café - done", "unicode_normalized", "café - FIN"],
      ["a   b   c\n", "a b c", "whitespace_normalized", "A B C"],
      // Pass 0 (escaped control chars) only fires for literal \t/\n in the
      // MIDDLE of oldText. A trailing newline alone doesn't produce a unique
      // escaped match here, so the robust_backslash pass still lands.
      [
        'const msg = \\"hello\\";\n',
        'const msg = "hello";\n',
        "robust_backslash",
        'const msg = "HELLO";\n',
      ],
      [
        "const a = 1;   \nconst b = 2;   // this trailing comment is intentionally very long and was appended later by another tool\n",
        "const a = 1;\nconst b = 2;",
        "robust_trimmed",
        "const a = 1;\nconst b = 2;\n",
      ],
    ];

    for (const [content, oldText, expectedPass, newText] of cases) {
      const file = write(`fuzzy-${expectedPass}.txt`, content);
      const result = await tool.execute(
        "call-" + expectedPass,
        { path: file, edits: [{ oldText, newText }] },
        undefined,
        undefined,
        ctx(),
      );
      expect(result.isError).toBeUndefined();
      expect((result.details.guard as { passNames: string[] }).passNames).toContain(expectedPass);
      const written = readFileSync(file, "utf8");
      expect(written).toContain(newText);
    }
  });

  it("anchor restricts the window for file-level-ambiguous oldText", async () => {
    const lines = ["aaa", "MARKER", ...Array.from({ length: 18 }, (_, i) => `fill-${i}`), "MARKER"];
    const file = write("anchor.txt", lines.join("\n"));

    const result = await tool.execute(
      "call-anchor",
      {
        path: file,
        edits: [{ oldText: "MARKER", newText: "HIT", anchor: "aaa" }],
      },
      undefined,
      undefined,
      ctx(),
    );

    expect(result.isError).toBeUndefined();
    const written = readFileSync(file, "utf8");
    expect(written.split("\n").filter((l) => l === "HIT")).toHaveLength(1);
    expect(written.split("\n").filter((l) => l === "MARKER")).toHaveLength(1);
    expect((result.details.guard as { anchorUsed: boolean }).anchorUsed).toBe(true);
  });

  it("throws with the closest candidate on a total miss", async () => {
    // Function that does not exist anywhere in the file — no fuzzy pass can
    // rescue it; executeFile reports the closest candidate.
    const file = write(
      "miss.txt",
      "function hello() {\n  return 42;\n}\nfunction hello() {\n  return 43;\n}\n",
    );

    await expect(
      tool.execute(
        "call-miss",
        {
          path: file,
          edits: [
            {
              oldText: "function goodbye() {\n  return 44;\n}\n",
              newText: "X",
            },
          ],
        },
        undefined,
        undefined,
        ctx(),
      ),
    ).rejects.toThrow(/Closest match/);
  });

  it("throws native-format error for an empty edits array", async () => {
    await expect(
      tool.execute(
        "call-empty",
        { path: "/tmp/whatever.txt", edits: [] },
        undefined,
        undefined,
        ctx(),
      ),
    ).rejects.toThrow(/edits must contain at least one replacement/);
  });

  it("throws when the file does not exist", async () => {
    await expect(
      tool.execute(
        "call-missing-file",
        { path: "/tmp/does-not-exist-12345.txt", edits: [{ oldText: "a", newText: "b" }] },
        undefined,
        undefined,
        ctx(),
      ),
    ).rejects.toThrow(/file not found/);
  });

  it("throws when all edits are missing", async () => {
    const file = write("all-missing.txt", "hello world");
    await expect(
      tool.execute(
        "call-all-missing",
        {
          path: file,
          edits: [
            { oldText: "goodbye", newText: "universe" },
            { oldText: "foo", newText: "bar" },
          ],
        },
        undefined,
        undefined,
        ctx(),
      ),
    ).rejects.toThrow(/Closest match/);
  });

  it("throws when all edits are ambiguous", async () => {
    const file = write("all-ambiguous.txt", "a\na\na\nb\nb\nb");
    await expect(
      tool.execute(
        "call-all-ambiguous",
        {
          path: file,
          edits: [
            { oldText: "a", newText: "X" },
            { oldText: "b", newText: "Y" },
          ],
        },
        undefined,
        undefined,
        ctx(),
      ),
    ).rejects.toThrow(/ambiguous/);
  });

  it("throws when all edits are no-ops", async () => {
    const file = write("all-noop.txt", "hello\nworld");
    await expect(
      tool.execute(
        "call-all-noop",
        {
          path: file,
          edits: [
            { oldText: "hello", newText: "hello" },
            { oldText: "world", newText: "world" },
          ],
        },
        undefined,
        undefined,
        ctx(),
      ),
    ).rejects.toThrow(/does nothing|identical/i);
  });

  it("partial apply with replaceAll reports edit-object counts in tool output", async () => {
    const file = write("partial-replaceall.txt", "foo bar foo baz foo\nline2\n");
    const result = await tool.execute(
      "call-partial-replaceall",
      {
        path: file,
        edits: [
          { oldText: "foo", newText: "qux", replaceAll: true },
          { oldText: "line2", newText: "LINE2" },
          { oldText: "missing", newText: "MISSING" },
        ],
      },
      undefined,
      undefined,
      ctx(),
    );

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    // Tool-layer summary must count edit objects, not raw replacements.
    expect(text).toContain("[PARTIAL APPLY] Applied 2 of 3 edits");
    expect(text).toContain("edits[2]: missing");
    // Pass names are internals — details.guard only, never model-visible text.
    expect(text).not.toContain("Matches:");
    expect((result.details.guard as { passNames: string[] }).passNames).toContain("replace_all");
    // details.guard carries the edit-object counts
    expect((result.details.guard as any).appliedCount).toBe(2);
    expect((result.details.guard as any).failedCount).toBe(1);
    expect((result.details.guard as any).isPartial).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("qux bar qux baz qux\nLINE2\n");
  });

  it("partial apply reports actionable ambiguous guidance", async () => {
    const file = write("partial-ambiguous.txt", "a\na\na\nb\n");
    const result = await tool.execute(
      "call-partial-ambiguous",
      {
        path: file,
        edits: [
          { oldText: "b", newText: "B" },
          { oldText: "a", newText: "A" },
        ],
      },
      undefined,
      undefined,
      ctx(),
    );

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("[PARTIAL APPLY] Applied 1 of 2 edits");
    expect(text).toContain("edits[1]:");
    // Should not just repeat the status.
    expect(text).not.toContain("ambiguous (ambiguous)");
    // Should explain where the text appears and how to fix it.
    expect(text).toContain("text appears 3 times");
    expect(text).toContain("line 1, line 2, line 3");
    expect(text).toContain("provide more surrounding context");
    expect(text).toContain("replaceAll: true");
  });

  it("surfaces repair notes when args were repaired", async () => {
    const file = write("repaired.txt", "line1\nline2\nline3\n");

    // prepareArguments repairs aliases; execute correlates the notes
    const prepared = tool.prepareArguments({
      file_path: file,
      edits: [{ old_string: "line2", new_string: "LINE2" }],
    });
    expect(prepared).toBeDefined();

    const result = await tool.execute("call-repair", prepared, undefined, undefined, ctx());
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("<repair_note>");
    const guard = result.details.guard as { repaired: string[] };
    expect(guard.repaired.length).toBeGreaterThan(0);
    // Each note must appear exactly once — no duplication into the warnings block.
    const text = result.content[0]?.text ?? "";
    expect((text.match(/<repair_note>/g) ?? []).length).toBe(guard.repaired.length);
    expect(readFileSync(file, "utf8")).toBe("line1\nLINE2\nline3\n");
  });

  it("includes repair notes in thrown error when a repaired call fails", async () => {
    const file = write("repaired-fail.txt", "line1\nline2\nline3\n");

    const prepared = tool.prepareArguments({
      file_path: file,
      edits: [{ old_string: "missing", new_string: "X" }],
    });
    expect(prepared).toBeDefined();

    await expect(
      tool.execute("call-repair-fail", prepared, undefined, undefined, ctx()),
    ).rejects.toThrow(/<repair_note>/);
  });

  it("calls repairLifecycle.take on failure", async () => {
    const file = write("repaired-take.txt", "line1\nline2\nline3\n");
    const { repairLifecycle } = await import("../src/repair/entry.js");
    const takeSpy = vi.spyOn(repairLifecycle, "take");

    const prepared = tool.prepareArguments({
      file_path: file,
      edits: [{ old_string: "missing", new_string: "X" }],
    });

    await expect(
      tool.execute("call-repair-take", prepared, undefined, undefined, ctx()),
    ).rejects.toThrow();

    expect(takeSpy).toHaveBeenCalledTimes(1);
    expect(takeSpy).toHaveBeenCalledWith("call-repair-take");
  });

  it("throws without repair notes when args were not repaired", async () => {
    const file = write("no-repair-fail.txt", "line1\nline2\nline3\n");

    await expect(
      tool.execute(
        "call-no-repair-fail",
        { path: file, edits: [{ oldText: "missing", newText: "X" }] },
        undefined,
        undefined,
        ctx(),
      ),
    ).rejects.toThrow(/Closest match/);
  });

  it("keeps native flat-fold + JSON-string compatibility when repair is disabled", async () => {
    const prev = getConfig().repairEnabled;
    try {
      (getConfig() as { repairEnabled: boolean }).repairEnabled = false;

      // Flat oldText/newText still folds into edits[] (native parity)
      const flat = tool.prepareArguments({
        path: "/tmp/x.txt",
        oldText: "a",
        newText: "b",
      });
      expect(flat).toEqual({
        path: "/tmp/x.txt",
        edits: [{ oldText: "a", newText: "b" }],
      });

      // JSON-stringified edits still parse (native parity)
      const stringified = tool.prepareArguments({
        path: "/tmp/x.txt",
        edits: '[{"oldText": "a", "newText": "b"}]',
      });
      expect(stringified).toEqual({
        path: "/tmp/x.txt",
        edits: [{ oldText: "a", newText: "b" }],
      });
    } finally {
      (getConfig() as { repairEnabled: boolean }).repairEnabled = prev;
    }
  });

  it("killswitch: no registration when editOverrideEnabled is false", () => {
    const prev = getConfig().editOverrideEnabled;
    try {
      (getConfig() as { editOverrideEnabled: boolean }).editOverrideEnabled = false;
      const quietPi = createPiMock();
      registerEditTool(quietPi as unknown as ExtensionAPI);
      expect(quietPi.tools).toHaveLength(0);
    } finally {
      (getConfig() as { editOverrideEnabled: boolean }).editOverrideEnabled = prev;
    }
  });

  it("successful edit saves undo history", async () => {
    const file = write("undo-success.txt", "line1\nline2\nline3\n");
    const result = await tool.execute(
      "call-undo-success",
      { path: file, edits: [{ oldText: "line2", newText: "LINE2" }] },
      undefined,
      undefined,
      ctx(),
    );

    expect(result.isError).toBeUndefined();
    const undo = getUndo(file, process.env.PI_UNDO_STORE_PATH);
    expect(undo).toBeDefined();
    expect(undo!.content).toBe("line1\nline2\nline3\n");
    expect(undo!.resultContent).toBe("line1\nLINE2\nline3\n");
  });

  it("undo preserves mixed line endings (CRLF + LF)", async () => {
    // File with mixed line endings: CRLF on first line, LF on second
    const file = write("undo-mixed-endings.txt", "line1\r\nline2\n");
    const result = await tool.execute(
      "call-undo-mixed",
      { path: file, edits: [{ oldText: "line2", newText: "LINE2" }] },
      undefined,
      undefined,
      ctx(),
    );

    expect(result.isError).toBeUndefined();
    // After edit, the file should preserve the mixed endings
    const afterEdit = readFileSync(file, "utf8");
    expect(afterEdit).toBe("line1\r\nLINE2\n");

    // Undo should restore the original content exactly
    const { registerUndoTool } = await import("../src/platform/tools/undo.js");
    const undoPi = createPiMock();
    registerUndoTool(undoPi as unknown as ExtensionAPI);
    const undoTool = undoPi.tools[0] as {
      execute: (
        id: string,
        params: { path: string },
        signal: undefined,
        onUpdate: undefined,
        ctx: ReturnType<typeof makeCtx>,
      ) => Promise<{ content: Array<{ text?: string }>; details: Record<string, unknown> }>;
    };

    const undoResult = await undoTool.execute(
      "call-undo-mixed",
      { path: file },
      undefined,
      undefined,
      ctx(),
    );

    expect(undoResult.content[0]?.text).toContain("Undid last edit");
    const afterUndo = readFileSync(file, "utf8");
    // Must match the original bytes exactly (mixed endings preserved)
    expect(afterUndo).toBe("line1\r\nline2\n");
  });
});
