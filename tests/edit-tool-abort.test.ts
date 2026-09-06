/**
 * C1 regression — undo must survive stormbreaker aborts that land after
 * executeFile writes but before the old second throwIfAborted().
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPiMock, makeCtx } from "../packages/pi-base/src/pi-mock.js";
import { registerEditTool } from "../src/platform/tools/edit.js";

vi.mock("../src/edit/pipeline/execute.js", () => ({
  executeFile: vi.fn(),
  formatAlternatives: vi.fn(),
}));

vi.mock("../src/history/store.js", () => ({
  saveUndo: vi.fn(() => Promise.resolve({ persisted: true })),
  getUndo: vi.fn(),
  clearUndo: vi.fn(),
  // Constants consumed by the config layer (env.ts / settings.ts imports).
  DEFAULT_MAX_BYTES: 5_000_000,
  MIN_MAX_BYTES: 65_536,
  MAX_LIMIT_BYTES: 50_000_000,
  clampMaxBytes: (v: unknown) =>
    typeof v === "number" && Number.isFinite(v)
      ? Math.min(50_000_000, Math.max(65_536, Math.trunc(v)))
      : 5_000_000,
}));

const { executeFile } = await import("../src/edit/pipeline/execute.js");
const { saveUndo } = await import("../src/history/store.js");

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "edit-guard-abort-"));
  process.env.PI_UNDO_STORE_PATH = join(dir, "undo-store.json");
});

afterAll(() => {
  delete process.env.PI_UNDO_STORE_PATH;
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const file = join(dir, name);
  writeFileSync(file, content);
  return file;
}

describe("C1 — undo survives stormbreaker abort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("abort after executeFile still saves undo", async () => {
    const controller = new AbortController();

    (executeFile as any).mockImplementation(() => {
      const result = {
        isError: false,
        content: [{ type: "text", text: "ok" }],
        details: {
          baseContent: "a",
          newContent: "b",
          bom: "",
          originalEnding: "\n",
          coherenceWarnings: [],
          passNames: ["simple"],
          appliedCount: 1,
          editsApplied: [0],
          diagnostics: [],
          durationMs: 0,
          encoding: "utf-8",
        },
      };
      const p = Promise.resolve(result);
      p.then(() => controller.abort());
      return p;
    });

    const pi = createPiMock();
    registerEditTool(pi as unknown as ExtensionAPI);
    const tool = pi.tools[0] as {
      execute: (
        id: string,
        params: unknown,
        signal: AbortSignal | undefined,
        onUpdate: unknown,
        ctx: ReturnType<typeof makeCtx>,
      ) => Promise<{
        content: Array<{ type: string; text?: string }>;
        isError?: boolean;
        details: Record<string, unknown>;
      }>;
    };

    const file = write("abort-after.txt", "a");

    await expect(
      tool.execute(
        "call-abort-after",
        { path: file, edits: [{ oldText: "a", newText: "b" }] },
        controller.signal,
        undefined,
        makeCtx({ cwd: dir }),
      ),
    ).rejects.toThrow("Operation aborted");

    expect(saveUndo).toHaveBeenCalled();
  });

  it("abort before executeFile does NOT save undo", async () => {
    const controller = new AbortController();
    controller.abort();

    const pi = createPiMock();
    registerEditTool(pi as unknown as ExtensionAPI);
    const tool = pi.tools[0] as {
      execute: (
        id: string,
        params: unknown,
        signal: AbortSignal | undefined,
        onUpdate: unknown,
        ctx: ReturnType<typeof makeCtx>,
      ) => Promise<{
        content: Array<{ type: string; text?: string }>;
        isError?: boolean;
        details: Record<string, unknown>;
      }>;
    };

    const file = write("abort-before.txt", "a");

    await expect(
      tool.execute(
        "call-abort-before",
        { path: file, edits: [{ oldText: "a", newText: "b" }] },
        controller.signal,
        undefined,
        makeCtx({ cwd: dir }),
      ),
    ).rejects.toThrow("Operation aborted");

    expect(saveUndo).not.toHaveBeenCalled();
  });

  it("successful edit (no abort) saves undo as before", async () => {
    (executeFile as any).mockResolvedValue({
      isError: false,
      content: [{ type: "text", text: "ok" }],
      details: {
        baseContent: "a",
        newContent: "b",
        bom: "",
        originalEnding: "\n",
        coherenceWarnings: [],
        passNames: ["simple"],
        appliedCount: 1,
        editsApplied: [0],
        diagnostics: [],
        durationMs: 0,
        encoding: "utf-8",
      },
    });

    const pi = createPiMock();
    registerEditTool(pi as unknown as ExtensionAPI);
    const tool = pi.tools[0] as {
      execute: (
        id: string,
        params: unknown,
        signal: AbortSignal | undefined,
        onUpdate: unknown,
        ctx: ReturnType<typeof makeCtx>,
      ) => Promise<{
        content: Array<{ type: string; text?: string }>;
        isError?: boolean;
        details: Record<string, unknown>;
      }>;
    };

    const file = write("success.txt", "a");

    const result = await tool.execute(
      "call-success",
      { path: file, edits: [{ oldText: "a", newText: "b" }] },
      undefined,
      undefined,
      makeCtx({ cwd: dir }),
    );

    expect(result.isError).toBeUndefined();
    expect(saveUndo).toHaveBeenCalled();
  });
});
