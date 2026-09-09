// Stage 3.1 — stale-read self-heal + direct registry injection.
//
// 1. tool_result on successful edit/write self-refreshes the registry so the
//    agent's OWN writes never self-block the next edit (read → write → edit).
// 2. The edit tool receives the registry via registerEditTool(pi, { registry })
//    and self-refreshes after a successful write (no globalThis bridge).

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPiMock, makeCtx } from "../packages/pi-base/src/pi-mock.js";
import { registerStaleReadObserver } from "../src/platform/hooks/stale-read.js";
import { ReadRegistry } from "../src/guards/stale-read/registry.js";
import { registerEditTool } from "../src/platform/tools/edit.js";
import { telemetry } from "../src/telemetry.js";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "edit-guard-stale-"));
  process.env.PI_UNDO_STORE_PATH = join(dir, "undo-store.json");
});

afterAll(() => {
  delete process.env.PI_UNDO_STORE_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe("stale-read self-heal on tool_result", () => {
  it("a successful write self-heals a stale file (read → write → edit)", async () => {
    const pi = createPiMock();
    const handles = registerStaleReadObserver(pi as unknown as ExtensionAPI);
    const file = join(dir, "self-heal.txt");
    writeFileSync(file, "content\n");

    // Simulate: agent read at T; file then changed (mtime pushed to the future
    // so it beats the 50ms tolerance deterministically).
    handles.record(file);
    utimesSync(file, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    expect(handles.isFresh(file)).toBe(false); // stale — would block an edit

    // The agent's own write lands → tool_result self-heals
    writeFileSync(file, "content changed\n");
    await pi.emit("tool_result", {
      toolName: "write",
      isError: false,
      input: { path: file },
    });

    expect(handles.isFresh(file)).toBe(true); // no self-block on next edit
  });

  it("failed results do NOT self-heal (external-looking failure keeps the block)", async () => {
    const pi = createPiMock();
    const handles = registerStaleReadObserver(pi as unknown as ExtensionAPI);
    const file = join(dir, "no-heal.txt");
    writeFileSync(file, "content\n");

    handles.record(file);
    utimesSync(file, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    expect(handles.isFresh(file)).toBe(false);

    await pi.emit("tool_result", {
      toolName: "edit",
      isError: true,
      input: { path: file },
    });

    expect(handles.isFresh(file)).toBe(false); // still stale — edit failed
  });

  it("a successful read still records (existing behavior)", async () => {
    const pi = createPiMock();
    const handles = registerStaleReadObserver(pi as unknown as ExtensionAPI);
    const file = join(dir, "read-record.txt");
    writeFileSync(file, "content\n");

    await pi.emit("tool_result", {
      toolName: "read",
      isError: false,
      input: { path: file },
    });

    expect(handles.registry.lastRead(file)).toEqual(expect.any(Number));
  });
});

describe("edit tool stale-read warning", () => {
  it("appends a stale-read advisory when the registry already warned", async () => {
    const pi = createPiMock();
    const _handles = registerStaleReadObserver(pi as unknown as ExtensionAPI);
    const selfRefresh = vi.fn();
    const getStaleWarning = vi.fn(
      () =>
        "[stale-read advisory] The file may have changed since your last read. The edit will proceed, but verify the result.",
    );
    registerEditTool(pi as unknown as ExtensionAPI, {
      registry: { selfRefresh, getStaleWarning },
    });

    const tool = pi.tools[0] as {
      execute: (
        id: string,
        params: unknown,
        signal: undefined,
        onUpdate: undefined,
        ctx: ReturnType<typeof makeCtx>,
      ) => Promise<{
        content: Array<{ text?: string }>;
        details: Record<string, unknown>;
      }>;
    };
    const file = join(dir, "warning-advisory.txt");
    writeFileSync(file, "line1\nline2\n");

    const result = await tool.execute(
      "call-1",
      { path: file, edits: [{ oldText: "line1", newText: "LINE1" }] },
      undefined,
      undefined,
      makeCtx({ cwd: dir }),
    );

    expect(result.details.diff).toBeDefined();
    expect(result.content[0]?.text).toContain("[WARNINGS]");
    expect(result.content[0]?.text).toContain("- [stale-read advisory]");
    // The tool forwards the call's search texts so the registry can gate
    // the surface on verbatim-safety (formatter noise stays silent).
    expect(getStaleWarning).toHaveBeenCalledWith(file, ["line1"]);
  });

  it("does not append a warning when getStaleWarning returns null", async () => {
    const pi = createPiMock();
    const _handles = registerStaleReadObserver(pi as unknown as ExtensionAPI);
    const selfRefresh = vi.fn();
    const getStaleWarning = vi.fn(() => null);
    registerEditTool(pi as unknown as ExtensionAPI, {
      registry: { selfRefresh, getStaleWarning },
    });

    const tool = pi.tools[0] as {
      execute: (
        id: string,
        params: unknown,
        signal: undefined,
        onUpdate: undefined,
        ctx: ReturnType<typeof makeCtx>,
      ) => Promise<{
        content: Array<{ text?: string }>;
        details: Record<string, unknown>;
      }>;
    };
    const file = join(dir, "no-warning.txt");
    writeFileSync(file, "line1\nline2\n");

    const result = await tool.execute(
      "call-1",
      { path: file, edits: [{ oldText: "line1", newText: "LINE1" }] },
      undefined,
      undefined,
      makeCtx({ cwd: dir }),
    );

    expect(result.content[0]?.text).not.toContain("[stale-read advisory]");
  });
});

describe("undo self-heals stale-read registry", () => {
  it("successful undo self-refreshes the registry", async () => {
    const pi = createPiMock();
    const handles = registerStaleReadObserver(pi as unknown as ExtensionAPI);
    const file = join(dir, "undo-self-heal.txt");
    writeFileSync(file, "content\n");

    handles.record(file);
    utimesSync(file, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    expect(handles.isFresh(file)).toBe(false);

    // Simulate successful undo restore (writes bump mtime to now)
    writeFileSync(file, "content\n");
    await pi.emit("tool_result", {
      toolName: "undo",
      isError: false,
      input: { path: file },
    });

    expect(handles.isFresh(file)).toBe(true);
  });

  it("failed undo does NOT self-refresh", async () => {
    const pi = createPiMock();
    const handles = registerStaleReadObserver(pi as unknown as ExtensionAPI);
    const file = join(dir, "undo-no-heal.txt");
    writeFileSync(file, "content\n");

    handles.record(file);
    utimesSync(file, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    expect(handles.isFresh(file)).toBe(false);

    await pi.emit("tool_result", {
      toolName: "undo",
      isError: true,
      input: { path: file },
    });

    expect(handles.isFresh(file)).toBe(false);
  });

  it("read -> edit -> undo -> edit does not self-block", async () => {
    const pi = createPiMock();
    const handles = registerStaleReadObserver(pi as unknown as ExtensionAPI);
    const file = join(dir, "read-edit-undo-edit.txt");
    writeFileSync(file, "line1\nline2\n");

    await pi.emit("tool_result", {
      toolName: "read",
      isError: false,
      input: { path: file },
    });

    writeFileSync(file, "line1\nLINE2\n");
    await pi.emit("tool_result", {
      toolName: "edit",
      isError: false,
      input: { path: file },
    });

    // Simulate undo restore
    writeFileSync(file, "line1\nline2\n");
    await pi.emit("tool_result", {
      toolName: "undo",
      isError: false,
      input: { path: file },
    });

    expect(handles.isFresh(file)).toBe(true);
  });
});

describe("ReadRegistry cwd correctness", () => {
  it("resolves and stats relative paths against the configured base dir, not process.cwd()", () => {
    // Simulate a session whose ctx.cwd differs from process.cwd(): the tool
    // layer hands the registry RELATIVE paths ("docs/f.txt"); keys and stat
    // calls must anchor to baseDir or the guard silently watches the wrong
    // file (stat miss → mtime -1 → always fresh).
    const stattedPaths: string[] = [];
    const registry = new ReadRegistry({
      baseDir: "/virtual/project",
      stat: (path) => {
        stattedPaths.push(path);
        // Only the recorded relative file looks modified; everything else
        // is untouched on disk.
        return { mtimeMs: path.endsWith("docs/f.txt") ? 1000 : 0 };
      },
      now: () => 500,
    });

    registry.record("docs/f.txt");
    expect(registry.lastRead("docs/f.txt")).toBe(500);

    const fresh = registry.isFresh("docs/f.txt");
    expect(fresh).toBe(false); // mtime 1000 > read 500 + tolerance
    // The stat must have targeted the BASE-RESOLVED path.
    expect(stattedPaths).toContain("/virtual/project/docs/f.txt");
    expect(stattedPaths).not.toContain("docs/f.txt");

    // Absolute inputs bypass baseDir resolution (resolve semantics).
    registry.record("/other/g.txt");
    expect(registry.isFresh("/other/g.txt")).toBe(true);
    expect(stattedPaths).toContain("/other/g.txt");
  });
});

describe("stale-read hook — advisory passes, oldTexts forwarded", () => {
  it("does NOT block when assertFresh returns the advisory kind", async () => {
    const pi = createPiMock();
    const handles = registerStaleReadObserver(pi as unknown as ExtensionAPI);
    const file = join(dir, "advisory.txt");
    writeFileSync(file, "content\n");

    handles.record(file);
    utimesSync(file, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    // First contact blocks...
    const blocked = await pi.emit(
      "tool_call",
      { toolName: "edit", input: { path: file } },
      makeCtx({ cwd: dir }),
    );
    expect(blocked).toMatchObject({ block: true });

    // ...repeat contact with the SAME drifted state must pass through —
    // blocking forever pushes models to sed/cat workarounds (mined 2026-08).
    const second = await pi.emit(
      "tool_call",
      { toolName: "edit", input: { path: file } },
      makeCtx({ cwd: dir }),
    );
    expect(second).toBeUndefined();
  });

  it("forwards edits[].oldText to assertFresh for the verbatim-safety check", async () => {
    const pi = createPiMock();
    const handles = registerStaleReadObserver(pi as unknown as ExtensionAPI);
    const probe = vi.spyOn(handles.registry, "assertFresh");
    const file = join(dir, "oldtext-forward.txt");
    writeFileSync(file, "alpha\nbeta\n");

    handles.record(file);
    utimesSync(file, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));

    await pi.emit(
      "tool_call",
      {
        toolName: "edit",
        input: {
          path: file,
          edits: [
            { oldText: "alpha", newText: "gamma" },
            { oldText: "beta", newText: "delta" },
          ],
        },
      },
      makeCtx({ cwd: dir }),
    );

    expect(probe).toHaveBeenCalledTimes(1);
    const [, opts] = probe.mock.calls[0]!;
    expect(opts).toEqual({ oldTexts: ["alpha", "beta"] });
  });

  it("a verbatim-safe stale edit is NOT blocked on first contact", async () => {
    const pi = createPiMock();
    const handles = registerStaleReadObserver(pi as unknown as ExtensionAPI);
    const file = join(dir, "verbatim-safe.txt");
    writeFileSync(file, "alpha\nbeta\ngamma\n");

    handles.record(file);
    // External rewrite that leaves the target line intact.
    writeFileSync(file, "alpha\nbeta\ngamma\n// formatter footer\n");
    utimesSync(file, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));

    const result = await pi.emit(
      "tool_call",
      {
        toolName: "edit",
        input: { path: file, edits: [{ oldText: "beta", newText: "beta // touched" }] },
      },
      makeCtx({ cwd: dir }),
    );
    expect(result).toBeUndefined(); // proceed; tool layer appends the advisory
  });
});

describe("formatter noise end to end (real registry + real edit tool)", () => {
  it("a verbatim-safe edit after external formatter drift lands with NO stale advisory", async () => {
    // Mined 2026-09: agent reads → oxfmt/prettier rewrites (target lines
    // intact) → edit lands fine but the advisory spammed result text.
    const pi = createPiMock();
    const _handles = registerStaleReadObserver(pi as unknown as ExtensionAPI);
    // NOTE: pass the live registry object (method-call form keeps `this`);
    // the executor's detached selfRefresh is best-effort by design.
    registerEditTool(pi as unknown as ExtensionAPI, {
      registry: _handles.registry,
    });
    const file = join(dir, "formatter-noise-e2e.txt");
    writeFileSync(file, "alpha\nbeta\ngamma\n");

    await pi.emit(
      "tool_result",
      { toolName: "read", isError: false, input: { path: file } },
      makeCtx({ cwd: dir }),
    );

    // External formatter drift: content rewritten, target line intact.
    writeFileSync(file, "alpha\nbeta\ngamma\n// fmt footer\n");
    const future = new Date(Date.now() + 60_000);
    utimesSync(file, future, future);

    const callResult = await pi.emit(
      "tool_call",
      {
        toolName: "edit",
        input: { path: file, edits: [{ oldText: "beta", newText: "BETA" }] },
      },
      makeCtx({ cwd: dir }),
    );
    expect(callResult).toBeUndefined(); // verbatim-safe downgrade: proceed

    const tool = pi.tools[0] as {
      execute: (
        id: string,
        params: unknown,
        signal: undefined,
        onUpdate: undefined,
        ctx: ReturnType<typeof makeCtx>,
      ) => Promise<{ content: Array<{ text?: string }> }>;
    };
    const result = await tool.execute(
      "call-1",
      { path: file, edits: [{ oldText: "beta", newText: "BETA" }] },
      undefined,
      undefined,
      makeCtx({ cwd: dir }),
    );

    expect(result.content[0]?.text).toContain("Successfully replaced 1 block(s)");
    expect(result.content[0]?.text).not.toContain("[stale-read advisory]");
  });
});

describe("stale_read.self_healed telemetry gating", () => {
  // The telemetry counter is cumulative across tests, so we order them
  // to verify deltas: 0 → 1 → 1 → 2 → 2.

  it("does NOT emit self_healed when the file is fresh", async () => {
    const pi = createPiMock();
    const handles = registerStaleReadObserver(pi as unknown as ExtensionAPI);
    const file = join(dir, "telemetry-fresh-edit.txt");
    writeFileSync(file, "line1\nline2\n");

    handles.record(file);
    // File is fresh — assertFresh returns null, staleOnToolCall not set.

    await pi.emit("tool_call", { toolName: "edit", input: { path: file } }, makeCtx({ cwd: dir }));

    await pi.emit("tool_result", {
      toolName: "edit",
      isError: false,
      input: { path: file },
    });

    const stats = telemetry.stats();
    expect(stats.staleReadSelfHealed).toBe(0);
  });

  it("emits self_healed when a stale edit succeeds", async () => {
    const pi = createPiMock();
    const handles = registerStaleReadObserver(pi as unknown as ExtensionAPI);
    const file = join(dir, "telemetry-stale-edit.txt");
    writeFileSync(file, "line1\nline2\n");

    handles.record(file);
    utimesSync(file, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    expect(handles.isFresh(file)).toBe(false);

    // Simulate successful edit — tool_call sets staleOnToolCall,
    // tool_result fires selfRefreshTracked which should emit self_healed.
    await pi.emit("tool_call", { toolName: "edit", input: { path: file } }, makeCtx({ cwd: dir }));

    await pi.emit("tool_result", {
      toolName: "edit",
      isError: false,
      input: { path: file },
    });

    const stats = telemetry.stats();
    expect(stats.staleReadSelfHealed).toBe(1);
  });

  it("does NOT emit self_healed on failed edit", async () => {
    const pi = createPiMock();
    const handles = registerStaleReadObserver(pi as unknown as ExtensionAPI);
    const file = join(dir, "telemetry-failed-edit.txt");
    writeFileSync(file, "line1\nline2\n");

    handles.record(file);
    utimesSync(file, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));

    await pi.emit("tool_call", { toolName: "edit", input: { path: file } }, makeCtx({ cwd: dir }));

    await pi.emit("tool_result", {
      toolName: "edit",
      isError: true,
      input: { path: file },
    });

    const stats = telemetry.stats();
    expect(stats.staleReadSelfHealed).toBe(1); // still 1 — failed edit does not emit
  });

  it("emits self_healed when a stale write succeeds", async () => {
    const pi = createPiMock();
    const handles = registerStaleReadObserver(pi as unknown as ExtensionAPI);
    const file = join(dir, "telemetry-stale-write.txt");
    writeFileSync(file, "original\n");

    handles.record(file);
    utimesSync(file, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    expect(handles.isFresh(file)).toBe(false);

    // Write tool — no executor selfRefresh, so tool_result samples isFresh
    // directly and sees the stale state.
    await pi.emit("tool_result", {
      toolName: "write",
      isError: false,
      input: { path: file },
    });

    const stats = telemetry.stats();
    expect(stats.staleReadSelfHealed).toBe(2); // incremented from 1 → 2
  });
});
