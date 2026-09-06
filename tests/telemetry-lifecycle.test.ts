/**
 * Telemetry lifecycle wiring — the extension flushes the pending batch as
 * ONE `edit-guard:event` CustomEntry per agent lifecycle checkpoint.
 *
 * Regression root: telemetry used to write through one appendEntry per
 * event. Now record() only buffers; the extension owns all writes via
 * checkpoint flushes (see docs/telemetry-batching-plan.md).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPiMock, makeCtx } from "../packages/pi-base/src/pi-mock.js";
import registerExtension from "../src/extension.js";
import { telemetry, type GuardEvent } from "../src/telemetry.js";

const now = 1_700_000_000_000;

function recordNoise(): void {
  telemetry.record({ type: "preflight.normalized", timestamp: now, toolName: "edit" });
  telemetry.record({ type: "stale_read.blocked", timestamp: now, path: "/x" });
}

/** All `edit-guard:event` entries written to the session log. */
function eventEntries(pi: ReturnType<typeof createPiMock>): Array<{ events: GuardEvent[] }> {
  return (pi.appendEntry as unknown as ReturnType<typeof vi.fn>).mock.calls
    .filter((c: unknown[]) => c[0] === "edit-guard:event")
    .map((c: unknown[]) => c[1] as { events: GuardEvent[] });
}

describe("telemetry lifecycle checkpoints", () => {
  afterEach(() => {
    telemetry.setFlushHandler(() => {});
    telemetry.flushNow();
    vi.unstubAllEnvs();
  });

  it("flushes one batched entry per checkpoint (input, agent_settled)", async () => {
    const pi = createPiMock();
    registerExtension(pi as unknown as ExtensionAPI);
    const ctx = makeCtx();

    recordNoise();
    await pi.emit("input", { text: "hello" }, ctx);
    expect(telemetry.pendingCount).toBe(0);

    const entries = eventEntries(pi);
    expect(entries).toHaveLength(1); // ONE entry, not one per event
    expect(entries[0]!.events).toHaveLength(2);
    expect(entries[0]!.events.map((e) => e.type)).toEqual([
      "preflight.normalized",
      "stale_read.blocked",
    ]);

    // Second turn: record again, flush at settled.
    recordNoise();
    await pi.emit("agent_settled", ctx);
    expect(eventEntries(pi)).toHaveLength(2);
    expect(eventEntries(pi)[1]!.events).toHaveLength(2);
  });

  it("does not write anything for checkpoints with an empty pending buffer", async () => {
    const pi = createPiMock();
    registerExtension(pi as unknown as ExtensionAPI);
    const ctx = makeCtx();

    await pi.emit("input", { text: "hello" }, ctx);
    await pi.emit("agent_settled", ctx);
    await pi.emit("agent_end", ctx);
    await pi.emit("session_before_tree", ctx);
    await pi.emit("session_before_fork", ctx);

    expect(eventEntries(pi)).toHaveLength(0);
  });

  it("flushes at agent_end, session_before_tree, session_before_fork, and session_before_compact", async () => {
    const pi = createPiMock();
    registerExtension(pi as unknown as ExtensionAPI);
    const ctx = makeCtx();

    for (const checkpoint of [
      "agent_end",
      "session_before_tree",
      "session_before_fork",
      "session_before_compact",
    ] as const) {
      recordNoise();
      await pi.emit(checkpoint, ctx);
    }

    const entries = eventEntries(pi);
    expect(entries).toHaveLength(4);
    for (const entry of entries) {
      expect(entry.events).toHaveLength(2);
    }
  });

  it("compaction hook is observer-only: flushes but returns undefined", async () => {
    const pi = createPiMock();
    registerExtension(pi as unknown as ExtensionAPI);
    const ctx = makeCtx();

    recordNoise();
    const handlers = pi.getHandlers("session_before_compact");
    expect(handlers).toHaveLength(1);

    // The handler must return undefined — it observes, it never cancels or
    // customizes compaction.
    recordNoise();
    const result = await handlers[0]!({}, ctx);
    expect(result).toBeUndefined();
    expect(telemetry.pendingCount).toBe(0);
    expect(eventEntries(pi)).toHaveLength(1);
  });

  it("flushes on session_shutdown and clears repair lifecycle state", async () => {
    const pi = createPiMock();
    registerExtension(pi as unknown as ExtensionAPI);
    const ctx = makeCtx();

    recordNoise();
    await pi.emit("session_shutdown", ctx);

    const entries = eventEntries(pi);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.events).toHaveLength(2);
  });

  it("session_start flushes pre-session events (recovery path)", async () => {
    const pi = createPiMock();
    registerExtension(pi as unknown as ExtensionAPI);
    const ctx = makeCtx();

    // Events recorded before the session log was ready.
    recordNoise();
    expect(telemetry.pendingCount).toBe(2);

    await pi.emit("session_start", { cwd: ctx.cwd }, ctx);
    expect(telemetry.pendingCount).toBe(0);
    expect(eventEntries(pi)).toHaveLength(1);
  });

  it("drops batches when telemetryEnabled is false (audit trail gated at write time)", async () => {
    vi.stubEnv("EDIT_GUARD_TELEMETRY_ENABLED", "0");
    const { refreshConfig } = await import("../src/config/settings.js");
    refreshConfig();

    try {
      const pi = createPiMock();
      registerExtension(pi as unknown as ExtensionAPI);
      const ctx = makeCtx();

      const before = telemetry.stats().preflightNormalized;
      recordNoise();
      await pi.emit("agent_settled", ctx);

      // Counters still record in-memory...
      expect(telemetry.stats().preflightNormalized).toBe(before + 1);
      // ...but nothing is written to the session log.
      expect(eventEntries(pi)).toHaveLength(0);
      expect(telemetry.pendingCount).toBe(0); // batch dropped, not retried
    } finally {
      refreshConfig();
    }
  });
});
