/**
 * Stale-read hook end to end against benchmark-shaped drift (pi-edit-benchmark
 * llm-report 2026-09-23: the hook never fired in ANY of the 340 pi-edit-guard
 * runs there, so every stale scenario was decided by content matching alone).
 *
 * These tests drive the real hook (registerStaleReadObserver) over real files
 * in an OS temp dir with deterministic future mtimes, proving the production
 * gate blocks exactly the graft class the benchmark lost on:
 * - multi-line stale queries with interior drift (b10/b15/insert-race shape)
 * - single-token stale targets (stale-line/b9/error-guidance shape)
 * while whitespace-only drift still proceeds and the re-read recovery loop
 * works. The final test runs the real edit tool behind the gate.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPiMock, makeCtx } from "../packages/pi-base/src/pi-mock.js";
import { registerStaleReadObserver } from "../src/platform/hooks/stale-read.js";
import { registerEditTool } from "../src/platform/tools/edit.js";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "edit-guard-stale-bench-"));
  process.env.PI_UNDO_STORE_PATH = join(dir, "undo-store.json");
});

afterAll(() => {
  delete process.env.PI_UNDO_STORE_PATH;
  rmSync(dir, { recursive: true, force: true });
});

const ctx = () => makeCtx({ cwd: dir });

/** Push the file's mtime deterministically past the stale tolerance. */
function driftMtime(file: string): void {
  const future = new Date(Date.now() + 60_000);
  utimesSync(file, future, future);
}

async function readRecorded(pi: ReturnType<typeof createPiMock>, file: string): Promise<void> {
  await pi.emit("tool_result", { toolName: "read", isError: false, input: { path: file } }, ctx());
}

async function editCall(
  pi: ReturnType<typeof createPiMock>,
  file: string,
  edits: Array<{ oldText: string; newText: string }>,
): Promise<unknown> {
  return pi.emit("tool_call", { toolName: "edit", input: { path: file, edits } }, ctx());
}

describe("stale-read hook blocks benchmark-shaped drift", () => {
  it("blocks a stale 181-line query with interior drift (b15 shape)", async () => {
    const pi = createPiMock();
    registerStaleReadObserver(pi as unknown as ExtensionAPI);
    const file = join(dir, "b15-e2e.ts");
    const fixture = Array.from({ length: 200 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
    writeFileSync(file, fixture);
    await readRecorded(pi, file);

    // External drift of one interior line after the read.
    writeFileSync(file, fixture.replace("line100", "line100-drifted"));
    driftMtime(file);

    const staleQuery = Array.from({ length: 181 }, (_, i) => `line${i + 10}`).join("\n");
    const blocked = await editCall(pi, file, [{ oldText: staleQuery, newText: "X\n" }]);
    expect(blocked).toMatchObject({ block: true });
    expect(JSON.stringify(blocked)).toMatch(/last read|re-read|stale/i);
    // Nothing applied — the drift survives.
    expect(readFileSync(file, "utf-8")).toBe(fixture.replace("line100", "line100-drifted"));
  });

  it("blocks a single-token edit onto a drifted line (stale-line shape)", async () => {
    const pi = createPiMock();
    registerStaleReadObserver(pi as unknown as ExtensionAPI);
    const file = join(dir, "stale-line-e2e.ts");
    writeFileSync(file, "aaa\nbbb\nccc\n");
    await readRecorded(pi, file);

    writeFileSync(file, "aaa\nbbb-external\nccc\n");
    driftMtime(file);

    const blocked = await editCall(pi, file, [{ oldText: "bbb", newText: "BBB" }]);
    expect(blocked).toMatchObject({ block: true });
    expect(readFileSync(file, "utf-8")).toBe("aaa\nbbb-external\nccc\n");
  });

  it("lets whitespace-only drift proceed without a block (formatter shape)", async () => {
    const pi = createPiMock();
    registerStaleReadObserver(pi as unknown as ExtensionAPI);
    const file = join(dir, "formatter-e2e.ts");
    writeFileSync(
      file,
      "function connect(opts) {\n  const host = opts.host;\n  const port = opts.port ?? 8080;\n}\n",
    );
    await readRecorded(pi, file);

    // Formatter doubles the indent after the read; the target token survives.
    writeFileSync(
      file,
      "function connect(opts) {\n    const host = opts.host;\n    const port = opts.port ?? 8080;\n}\n",
    );
    driftMtime(file);

    const result = await editCall(pi, file, [
      {
        oldText: "  const port = opts.port ?? 8080;",
        newText: "  const port = opts.port ?? 9090;",
      },
    ]);
    expect(result).toBeUndefined();
  });

  it("re-read resets the ladder so the corrected edit proceeds (recovery loop)", async () => {
    const pi = createPiMock();
    registerStaleReadObserver(pi as unknown as ExtensionAPI);
    const file = join(dir, "recovery-e2e.ts");
    writeFileSync(file, "aaa\nbbb\nccc\n");
    await readRecorded(pi, file);

    writeFileSync(file, "aaa\nbbb-external\nccc\n");
    driftMtime(file);
    expect(await editCall(pi, file, [{ oldText: "bbb", newText: "BBB" }])).toMatchObject({
      block: true,
    });

    // Agent re-reads the drifted bytes, then targets them exactly.
    await readRecorded(pi, file);
    const retry = await editCall(pi, file, [{ oldText: "bbb-external", newText: "BBB" }]);
    expect(retry).toBeUndefined();
  });
});

describe("stale-read gate in front of the real edit tool", () => {
  it("blocked edit never executes; corrected edit lands after re-read", async () => {
    const pi = createPiMock();
    registerStaleReadObserver(pi as unknown as ExtensionAPI);
    registerEditTool(pi as unknown as ExtensionAPI);
    const tool = (pi as unknown as { tools: unknown[] }).tools.find(
      (t) => (t as { name: string }).name === "edit",
    ) as unknown as {
      execute: (
        id: string,
        params: unknown,
        signal: undefined,
        onUpdate: undefined,
        ctx: unknown,
      ) => Promise<{ isError?: boolean; content: Array<{ text?: string }> }>;
    };
    expect(tool).toBeTruthy();

    const file = join(dir, "gated-e2e.ts");
    writeFileSync(file, "aaa\nbbb\nccc\n");
    await readRecorded(pi, file);

    writeFileSync(file, "aaa\nbbb-external\nccc\n");
    driftMtime(file);

    // Gate blocks: pi would not execute the tool — the drift survives.
    const gate = await editCall(pi, file, [{ oldText: "bbb", newText: "BBB" }]);
    expect(gate).toMatchObject({ block: true });
    expect(readFileSync(file, "utf-8")).toBe("aaa\nbbb-external\nccc\n");

    // Re-read, then the corrected edit lands through the real tool.
    await readRecorded(pi, file);
    expect(await editCall(pi, file, [{ oldText: "bbb-external", newText: "BBB" }])).toBeUndefined();
    const result = await tool.execute(
      "call-1",
      { path: file, edits: [{ oldText: "bbb-external", newText: "BBB" }] },
      undefined,
      undefined,
      ctx(),
    );
    expect(result.isError).toBeFalsy();
    expect(readFileSync(file, "utf-8")).toBe("aaa\nBBB\nccc\n");
  });
});
