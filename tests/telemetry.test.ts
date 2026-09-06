import { describe, it, expect } from "vitest";
import { EditGuardTelemetry, telemetry, type GuardEvent } from "../src/telemetry.js";
import { resolveBlocks } from "../src/edit/pipeline/resolve.js";
import { executeFile } from "../src/edit/pipeline/execute.js";
import { prepareEditArguments } from "../src/repair/entry.js";
import type { EditError } from "../src/edit/model.js";

const now = 1_700_000_000_000;

// ── Helpers ────────────────────────────────────────────────────────────────

function captureEvents(events: GuardEvent[]) {
  telemetry.setFlushHandler((batch) => events.push(...batch));
}

/** Reset the singleton for wiring tests: clear pending + ring buffer, install a flush handler. */
function resetSingleton(events: GuardEvent[]) {
  // Discard prior noise with a throwaway handler FIRST — installing the
  // capture handler before flushing would drain stale events into `events`
  // and poison the assertions below (same trap the stormbreaker tests dodge).
  telemetry.setFlushHandler(() => {});
  telemetry.flushNow();
  telemetry.drain();
  captureEvents(events);
}

// ── Counter aggregation (unchanged) ────────────────────────────────────────

describe("EditGuardTelemetry counters", () => {
  it("aggregates counters per event kind", () => {
    const t = new EditGuardTelemetry();
    t.record({
      type: "repair.rule",
      timestamp: now,
      ruleId: "renameAliasedField",
      outcome: "repaired",
    });
    t.record({
      type: "repair.rule",
      timestamp: now,
      ruleId: "renameAliasedField",
      outcome: "repaired",
    });
    t.record({
      type: "repair.rule",
      timestamp: now,
      ruleId: "flat-fold",
      outcome: "unrepairable",
      fingerprint: "abcd1234",
    });
    t.record({
      type: "preflight.normalized",
      timestamp: now,
      toolName: "edit",
      reason: "tilde",
    });
    t.record({
      type: "preflight.blocked",
      timestamp: now,
      toolName: "edit",
      reason: "no such file",
    });
    t.record({ type: "stale_read.blocked", timestamp: now, path: "/x" });
    t.record({ type: "stale_read.self_healed", timestamp: now, path: "/x" });
    t.record({
      type: "stormbreaker.enhanced",
      timestamp: now,
      toolName: "edit",
      count: 1,
    });
    t.record({
      type: "stormbreaker.loop_broken",
      timestamp: now,
      toolName: "edit",
      count: 3,
    });
    t.record({
      type: "match.closest_candidate",
      timestamp: now,
      similarity: 0.8,
    });
    t.record({
      type: "match.closest_candidate",
      timestamp: now,
      similarity: 0.4,
    });

    const stats = t.stats();
    expect(stats.repairRules).toEqual({
      renameAliasedField: 2,
      "flat-fold": 1,
    });
    expect(stats.unrepairableFingerprints).toEqual({ abcd1234: 1 });
    expect(stats.preflightNormalized).toBe(1);
    expect(stats.preflightBlocked).toBe(1);
    expect(stats.staleReadBlocked).toBe(1);
    expect(stats.staleReadSelfHealed).toBe(1);
    expect(stats.stormbreakerEnhanced).toBe(1);
    expect(stats.stormbreakerLoopBroken).toBe(1);
    expect(stats.closestCandidateCount).toBe(2);
    expect(stats.meanClosestSimilarity).toBe(0.6);
    expect(stats.eventsRecorded).toBe(11);
  });

  it("aggregates edit.applied into per-pass counters and mean duration", () => {
    const t = new EditGuardTelemetry();
    t.record({
      type: "edit.applied",
      timestamp: now,
      editsApplied: 2,
      passNames: ["exact", "exact"],
      anchorUsed: true,
      durationMs: 10,
      coherenceWarnings: 0,
    });
    t.record({
      type: "edit.applied",
      timestamp: now,
      editsApplied: 1,
      passNames: ["auto_expand"],
      anchorUsed: false,
      durationMs: 20,
      coherenceWarnings: 1,
    });
    // anchorUsed/autoExpand are counted from match.pass events (per edit, closest to
    // the source) — edit.applied's flags never double-count.
    t.record({
      type: "match.pass",
      timestamp: now,
      passName: "exact",
      autoExpand: false,
      anchorUsed: true,
    });

    const stats = t.stats();
    expect(stats.editsApplied).toBe(3);
    expect(stats.editsAppliedByPass).toEqual({ exact: 2, auto_expand: 1 });
    expect(stats.anchorUsed).toBe(1); // one match.pass, not edit.applied(2)
    expect(stats.autoExpand).toBe(0); // autoExpand counted from match.pass events
    expect(stats.meanEditDurationMs).toBe(15);
  });

  it("counts autoExpand from match.pass events", () => {
    const t = new EditGuardTelemetry();
    t.record({
      type: "match.pass",
      timestamp: now,
      passName: "auto_expand",
      autoExpand: true,
      anchorUsed: false,
    });
    t.record({
      type: "match.pass",
      timestamp: now,
      passName: "exact",
      autoExpand: false,
      anchorUsed: true,
    });
    const stats = t.stats();
    expect(stats.autoExpand).toBe(1);
    expect(stats.anchorUsed).toBe(1);
  });

  it("bounds the ring buffer to the last 50 events", () => {
    const t = new EditGuardTelemetry();
    for (let i = 0; i < 60; i++) {
      t.record({
        type: "preflight.normalized",
        timestamp: now + i,
        toolName: "edit",
      });
    }
    const drained = t.drain();
    expect(drained).toHaveLength(50);
    // Oldest 10 dropped — the first surviving event has timestamp now + 10
    expect(drained[0]).toMatchObject({ timestamp: now + 10 });
    expect(drained[49]).toMatchObject({ timestamp: now + 59 });
  });

  it("drain clears the buffer but keeps counters", () => {
    const t = new EditGuardTelemetry();
    t.record({
      type: "preflight.blocked",
      timestamp: now,
      toolName: "edit",
      reason: "x",
    });
    t.record({
      type: "preflight.blocked",
      timestamp: now,
      toolName: "edit",
      reason: "y",
    });

    expect(t.drain()).toHaveLength(2);
    expect(t.drain()).toHaveLength(0); // second drain is empty
    expect(t.stats().preflightBlocked).toBe(2); // counters survive
    expect(t.stats().eventsRecorded).toBe(2);
  });

  it("starts empty and reports zeroed stats", () => {
    const t = new EditGuardTelemetry();
    expect(t.isEmpty).toBe(true);
    const stats = t.stats();
    expect(stats.eventsRecorded).toBe(0);
    expect(stats.meanEditDurationMs).toBe(0);
    expect(stats.editsApplied).toBe(0);
  });

  it("round-trips events through drain for the audit trail", () => {
    const t = new EditGuardTelemetry();
    const events: GuardEvent[] = [
      {
        type: "repair.rule",
        timestamp: now,
        ruleId: "renameAliasedField",
        outcome: "repaired",
      },
      {
        type: "edit.applied",
        timestamp: now,
        editsApplied: 1,
        passNames: ["exact"],
        anchorUsed: false,
        durationMs: 5,
        coherenceWarnings: 0,
      },
    ];
    for (const event of events) t.record(event);
    expect(t.drain()).toEqual(events);
  });
});

// ── Batching API ───────────────────────────────────────────────────────────

describe("EditGuardTelemetry batching", () => {
  it("buffers events in #pending; record() does not call the flush handler", () => {
    const t = new EditGuardTelemetry();
    const flushed: GuardEvent[][] = [];
    t.setFlushHandler((batch) => flushed.push(batch));

    t.record({
      type: "preflight.blocked",
      timestamp: now,
      toolName: "edit",
      reason: "x",
    });
    t.record({
      type: "repair.rule",
      timestamp: now,
      ruleId: "flat-fold",
      outcome: "repaired",
    });

    expect(flushed).toHaveLength(0); // no writes during record()
    expect(t.pendingCount).toBe(2);
    expect(t.stats().eventsRecorded).toBe(2); // counters still live
  });

  it("flushNow drains #pending and calls the handler once with the batch", () => {
    const t = new EditGuardTelemetry();
    const flushed: GuardEvent[][] = [];
    t.setFlushHandler((batch) => flushed.push(batch));

    t.record({
      type: "preflight.blocked",
      timestamp: now,
      toolName: "edit",
      reason: "x",
    });
    t.record({
      type: "repair.rule",
      timestamp: now,
      ruleId: "flat-fold",
      outcome: "repaired",
    });

    const batch = t.flushNow();
    expect(batch).toHaveLength(2);
    expect(batch[0]).toMatchObject({ type: "preflight.blocked" });
    expect(batch[1]).toMatchObject({ type: "repair.rule" });
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toBe(batch);
    expect(t.pendingCount).toBe(0);
  });

  it("is idempotent when pending is empty", () => {
    const t = new EditGuardTelemetry();
    const flushed: GuardEvent[][] = [];
    t.setFlushHandler((batch) => flushed.push(batch));

    expect(t.flushNow()).toEqual([]);
    expect(flushed).toHaveLength(0);
    expect(t.pendingCount).toBe(0);
  });

  it("auto-flushes when pending exceeds the 128-event cap (overflow valve)", () => {
    const t = new EditGuardTelemetry();
    const flushed: GuardEvent[][] = [];
    t.setFlushHandler((batch) => flushed.push(batch));

    for (let i = 0; i < 129; i++) {
      t.record({
        type: "preflight.normalized",
        timestamp: now + i,
        toolName: "edit",
      });
    }

    // 129 records → one auto-flush at 128, then 1 remaining
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toHaveLength(128);
    expect(t.pendingCount).toBe(1);
    expect(t.stats().eventsRecorded).toBe(129);

    // Explicit flush drains the tail
    const tail = t.flushNow();
    expect(tail).toHaveLength(1);
    expect(flushed).toHaveLength(2);
  });

  it("isolates handler errors so record() counters still update", () => {
    const t = new EditGuardTelemetry();
    t.setFlushHandler(() => {
      throw new Error("appendEntry failed");
    });

    t.record({
      type: "preflight.blocked",
      timestamp: now,
      toolName: "edit",
      reason: "x",
    });

    expect(t.stats().preflightBlocked).toBe(1); // counters survive
    expect(t.pendingCount).toBe(1); // pending retained for the next checkpoint
  });

  it("keeps the pending batch for retry when the handler throws (no silent batch loss)", () => {
    const t = new EditGuardTelemetry();
    const flushed: GuardEvent[][] = [];
    let failing = true;
    t.setFlushHandler((batch) => {
      if (failing) throw new Error("appendEntry failed (disk full)");
      flushed.push(batch);
    });

    t.record({ type: "preflight.blocked", timestamp: now, toolName: "edit", reason: "a" });
    t.record({ type: "preflight.normalized", timestamp: now, toolName: "edit" });

    // Transient handler failure: the batch must survive for the next
    // checkpoint — dropping it here would silently lose up to PENDING_MAX
    // events (pre-batching, a sink throw lost only the single event).
    const first = t.flushNow();
    expect(first).toHaveLength(2);
    expect(t.pendingCount).toBe(2); // retained, not drained

    // Repeated failures neither lose nor grow the batch
    t.flushNow();
    t.flushNow();
    expect(t.pendingCount).toBe(2);

    // Recovery: the very next successful flush delivers the SAME batch
    failing = false;
    const second = t.flushNow();
    expect(second).toHaveLength(2);
    expect(t.pendingCount).toBe(0);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toHaveLength(2);
  });

  it("drain() still returns the ring buffer (independent of #pending)", () => {
    const t = new EditGuardTelemetry();
    const flushed: GuardEvent[][] = [];
    t.setFlushHandler((batch) => flushed.push(batch));

    // Record 60 events — ring buffer caps at 50, pending holds all 60
    for (let i = 0; i < 60; i++) {
      t.record({
        type: "preflight.normalized",
        timestamp: now + i,
        toolName: "edit",
      });
    }

    expect(t.pendingCount).toBe(60);
    expect(t.flushNow()).toHaveLength(60);

    // Ring buffer is separate — it held the last 50 of the 60 records
    const ring = t.drain();
    expect(ring).toHaveLength(50);
    expect(ring[0]).toMatchObject({ timestamp: now + 10 }); // oldest 10 dropped
  });
});

// ── Envelope recording (unchanged, but no sink) ─────────────────────────────

describe("envelope recording", () => {
  it("record(envelope) updates GuardStats and lands in #pending + ring buffer", () => {
    const t = new EditGuardTelemetry();
    const flushed: GuardEvent[][] = [];
    t.setFlushHandler((batch) => flushed.push(batch));

    const token = t.beginEdit("/tmp/notes.md", 0);
    const envelope = t.endEdit({
      token,
      editsApplied: 2,
      passNames: ["exact", "anchor"],
      anchorUsed: true,
      corruptionWarnings: ["dup block"],
      coherenceWarnings: ["brace imbalance"],
      postWriteWarnings: [],
    });
    expect(envelope?.type).toBe("edit.envelope");
    expect(envelope?.outcome).toBe("applied");

    t.record(envelope!);

    const stats = t.stats();
    expect(stats.envelopesEmitted).toBe(1);
    expect(stats.totalCorruptionWarnings).toBe(1);
    expect(stats.totalCoherenceWarnings).toBe(1);
    expect(stats.totalPostWriteWarnings).toBe(0);

    // Envelope is in #pending (not yet written)
    expect(t.pendingCount).toBe(1);
    expect(flushed).toHaveLength(0);

    // And also in the ring buffer for session-start drain.
    expect(t.drain().some((e) => e.type === "edit.envelope")).toBe(true);
  });

  it("endEdit outcome classifies partial and failed calls", () => {
    const t = new EditGuardTelemetry();

    let token = t.beginEdit("/tmp/a.txt", 0);
    expect(t.endEdit({ token, isPartial: true, appliedCount: 1, failedCount: 2 })?.outcome).toBe(
      "partial",
    );

    token = t.beginEdit("/tmp/b.txt", 0);
    expect(t.endEdit({ token, editsApplied: 0, failedCount: 3 })?.outcome).toBe("failed");
  });

  it("contexts are token-keyed: overlapping calls cannot clobber each other", () => {
    const t = new EditGuardTelemetry();

    const tokenA = t.beginEdit("/tmp/a.txt", 0);
    const tokenB = t.beginEdit("/tmp/b.txt", 0);

    // B ends first; A's context must survive B's completion...
    const envB = t.endEdit({ token: tokenB, editsApplied: 1 });
    expect(envB?.path).toBe("/tmp/b.txt");

    const envA = t.endEdit({ token: tokenA, editsApplied: 1 });
    expect(envA?.path).toBe("/tmp/a.txt");

    // ...and a stale token is inert: unknown ids return null instead of
    // emitting a mis-attributed envelope.
    expect(t.endEdit({ token: tokenB, editsApplied: 9 })).toBeNull();
  });

  it("clearEditContext only drops its own token", () => {
    const t = new EditGuardTelemetry();

    const tokenA = t.beginEdit("/tmp/a.txt", 0);
    const tokenB = t.beginEdit("/tmp/b.txt", 0);
    t.clearEditContext(tokenB);

    // B aborted pre-execute; A still completes normally.
    expect(t.endEdit({ token: tokenB, editsApplied: 1 })).toBeNull();
    expect(t.endEdit({ token: tokenA, editsApplied: 1 })?.path).toBe("/tmp/a.txt");
  });
});

// ── Production wiring (singleton) ──────────────────────────────────────────

describe("telemetry wiring (production modules emit into the singleton)", () => {
  it("resolveBlocks emits match.pass with anchorUsed and closest_candidate", () => {
    const captured: GuardEvent[] = [];
    resetSingleton(captured);

    const content = ["aaa", "MARKER", "bbb", "ccc", "ddd", "eee", "fff", "ggg", "hhh"].join("\n");

    // Anchored success
    const ok = resolveBlocks(
      content,
      [{ path: "f.txt", oldText: "MARKER", newText: "HIT", anchor: "aaa" }],
      "f.py",
    );
    expect(ok.ok).toBe(true);

    // Total miss with a closest candidate
    const miss = resolveBlocks(
      content,
      [{ path: "f.txt", oldText: "nonexistent text", newText: "X" }],
      "f.py",
    );
    expect(miss.ok).toBe(false);

    // Drain pending through the flush handler to inspect what was recorded.
    telemetry.flushNow();
    expect(captured.some((e) => e.type === "match.pass")).toBe(true);
    const pass = captured.find((e) => e.type === "match.pass");
    expect(pass).toMatchObject({ type: "match.pass", anchorUsed: true });
    const closest = captured.find((e) => e.type === "match.closest_candidate");
    expect(closest).toMatchObject({
      type: "match.closest_candidate",
      lineRange: expect.objectContaining({ start: expect.any(Number) }),
    });
  });

  it("anchor.not_found emits, then full retry applies verbatim-unique oldText (P5)", () => {
    const captured: GuardEvent[] = [];
    resetSingleton(captured);

    const content = ["ddd", "def helper():\n", "return 4", "def helper():\n"].join("\n");

    // Anchor text appears nowhere; "return 4" is unique → the not-found
    // telemetry still records, but the edit is rescued by unanchored match.
    const missing = resolveBlocks(
      content,
      [
        {
          path: "f.py",
          oldText: "return 4",
          newText: "X",
          anchor: "no such text",
        },
      ],
      "f.py",
    );
    expect(missing.ok).toBe(true);
    expect(missing.diagnostics[0]?.anchorFallback).toBe(true);

    // Anchor text that appears more than once
    const ambiguous = resolveBlocks(
      content,
      [
        {
          path: "f.py",
          oldText: "return 4",
          newText: "X",
          anchor: "def helper():\n",
        },
      ],
      "f.py",
    );
    expect(ambiguous.ok).toBe(false);
    expect((ambiguous.errors[0] as EditError).kind).toBe("anchor-ambiguous");

    telemetry.flushNow();
    const notFound = captured.find((e) => e.type === "anchor.not_found");
    expect(notFound).toMatchObject({ type: "anchor.not_found", path: "f.py" });
    const amb = captured.find((e) => e.type === "anchor.ambiguous");
    expect(amb).toMatchObject({
      type: "anchor.ambiguous",
      path: "f.py",
      occurrences: 2,
    });
    expect(
      captured.find((e) => e.type === "match.pass" && e.passName === "anchor_not_found_full_retry"),
    ).toBeDefined();
    expect(telemetry.stats().anchorNotFound).toBe(1);
    expect(telemetry.stats().anchorAmbiguous).toBe(1);
  });

  it("executeFile emits edit.applied with passNames and duration", async () => {
    const captured: GuardEvent[] = [];
    resetSingleton(captured);

    const files: Record<string, Buffer | string> = {
      "/tmp/t.txt": Buffer.from("line1\nline2\n", "utf-8"),
    };
    const result = await executeFile("/tmp/t.txt", [{ oldText: "line1", newText: "LINE1" }], {
      readFile: (p) => files[p] as Buffer,
      writeFile: (p, data) => {
        files[p] = data;
      },
      rename: (from, to) => {
        files[to] = files[from] ?? Buffer.alloc(0);
      },
      exists: () => true,
    });
    expect(result.isError).toBe(false);

    telemetry.flushNow();
    const applied = captured.find((e) => e.type === "edit.applied");
    expect(applied).toMatchObject({
      type: "edit.applied",
      editsApplied: 1,
      passNames: ["simple"],
      anchorUsed: false,
      durationMs: expect.any(Number),
    });
  });

  it("prepareEditArguments emits repair.rule per change", () => {
    const captured: GuardEvent[] = [];
    resetSingleton(captured);

    const repaired = prepareEditArguments({
      file_path: "/tmp/x.txt",
      edits: [{ old_string: "a", new_string: "b" }],
    });
    expect(repaired).toBeDefined();

    telemetry.flushNow();
    const rules = captured.filter((e) => e.type === "repair.rule");
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every((r) => r.outcome === "repaired")).toBe(true);
  });
});
