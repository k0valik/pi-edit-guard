// Tool-layer regression: the partial-apply message must list WHICH edits
// applied. details.editsApplied used to be a bare count; the number[].join
// silently produced nothing and the applied-indices line never printed.
//
// Phrasing regression (mined pr-stack-session 2026-08-25): the line used to
// read "Applied edits: 0" — an INDEX LIST colliding with count semantics.
// It directly contradicted the header "Applied 1 of 3 edits" and reads to
// humans AND models as "zero edits applied".

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPiMock, makeCtx } from "../packages/pi-base/src/pi-mock.js";
import { registerEditTool } from "../src/platform/tools/edit.js";

vi.mock("../src/edit/pipeline/execute.js", () => ({
  executeFile: vi.fn(),
  formatAlternatives: vi.fn((alts?: unknown[]) => (alts?.length ? "alts" : "")),
  formatAmbiguousReason: vi.fn(() => "reason"),
}));

vi.mock("../src/history/store.js", () => ({
  saveUndo: vi.fn(() => Promise.resolve({ persisted: true })),
  getUndo: vi.fn(),
  clearUndo: vi.fn(),
  DEFAULT_MAX_BYTES: 5_000_000,
  MIN_MAX_BYTES: 65_536,
  MAX_LIMIT_BYTES: 50_000_000,
  clampMaxBytes: (v: unknown) =>
    typeof v === "number" && Number.isFinite(v)
      ? Math.min(50_000_000, Math.max(65_536, Math.trunc(v)))
      : 5_000_000,
}));

const { executeFile } = await import("../src/edit/pipeline/execute.js");

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "edit-guard-applied-idx-"));
  process.env.PI_UNDO_STORE_PATH = join(dir, "undo-store.json");
});

afterAll(() => {
  delete process.env.PI_UNDO_STORE_PATH;
  rmSync(dir, { recursive: true, force: true });
});

async function runEdit(details: Record<string, unknown>): Promise<string> {
  (executeFile as any).mockResolvedValue({
    isError: false,
    content: [{ type: "text", text: "x" }],
    details,
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
    ) => Promise<{ content: Array<{ type: string; text?: string }> }>;
  };
  const result = await tool.execute(
    "call-1",
    { path: join(dir, "f.txt"), edits: [{ oldText: "a", newText: "b" }] },
    undefined,
    undefined,
    makeCtx({ cwd: dir }),
  );
  return result.content.map((c) => c.text ?? "").join("\n");
}

describe("partial apply lists applied edit indices", () => {
  it("prints the applied indices in edits[N] vocabulary", async () => {
    const text = await runEdit({
      baseContent: "a",
      newContent: "b",
      bom: "",
      originalEnding: "\n",
      coherenceWarnings: [],
      corruptionWarnings: [],
      postWriteWarnings: [],
      passNames: ["simple"],
      isPartial: true,
      appliedCount: 2,
      failedCount: 1,
      editsApplied: [0, 2],
      diagnostics: [
        { index: 0, status: "applied", oldText: "a", newText: "b" },
        {
          index: 1,
          status: "missing",
          oldText: "gone",
          newText: "back",
          reason: "not found",
        },
        { index: 2, status: "applied", oldText: "c", newText: "d" },
      ],
      durationMs: 1,
      encoding: "utf-8",
    });
    // Same edits[N] vocabulary as the Failures lines — no count collision.
    expect(text).toContain("Applied edit indices: edits[0], edits[2]");
    expect(text).not.toContain("Applied edits:");
  });

  it("omits the line when nothing applied", async () => {
    const text = await runEdit({
      baseContent: "a",
      newContent: "a",
      bom: "",
      originalEnding: "\n",
      coherenceWarnings: [],
      corruptionWarnings: [],
      postWriteWarnings: [],
      passNames: [],
      isPartial: true,
      appliedCount: 0,
      failedCount: 1,
      editsApplied: [],
      diagnostics: [{ index: 0, status: "noop", oldText: "a", newText: "a" }],
      durationMs: 1,
      encoding: "utf-8",
    });
    expect(text).not.toContain("Applied edit indices:");
    expect(text).not.toContain("Applied edits:");
  });
});
