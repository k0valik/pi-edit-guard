/**
 * Edit Guard — better tool calling for `edit`.
 *
 * One prompt surface: the model calls `edit` and behind that name gets:
 * - Argument repair (prepareArguments slot — full repair pipeline)
 * - Exact matching + multi-pass fuzzy chain + anchor-scoped search + auto-expand
 * - Byte-preserving atomic writes (raw-splice)
 * - Stale-read protection + path preflight (hooks)
 * - Error enhancement + loop breaking (stormbreaker)
 * - Instrumentation (session audit trail, /edit-guard)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerEditTool } from "./platform/tools/edit.js";
import { registerUndoTool } from "./platform/tools/undo.js";
import { registerStormBreaker } from "./platform/hooks/stormbreaker.js";
import { registerStaleReadObserver } from "./platform/hooks/stale-read.js";
import { registerPreflight } from "./platform/hooks/preflight.js";
import { registerOverwriteGuard } from "./platform/hooks/overwrite.js";
import { registerEditGuardCommand } from "./platform/commands/edit-guard/index.js";
import { refreshConfig, getConfig } from "./config/settings.js";
import { telemetry, type GuardEvent } from "./telemetry.js";
import { repairLifecycle } from "./repair/entry.js";

export default (pi: ExtensionAPI) => {
  // Own all audit-trail writes through a single batch handler. Extension
  // modules never call appendEntry directly; lifecycle hooks and the
  // status command trigger flushNow(), which drains the pending buffer
  // and hands the batch to this handler once per checkpoint.
  const flushTelemetry = (events: GuardEvent[]): void => {
    if (events.length === 0 || !getConfig().telemetryEnabled) return;
    pi.appendEntry("edit-guard:event", { events });
  };
  telemetry.setFlushHandler(flushTelemetry);

  // Register hooks first — the stale-read registry is injected into the edit
  // tool below.
  const stormbreakerHandles = registerStormBreaker(pi);
  const staleReadHandles = registerStaleReadObserver(pi);
  registerPreflight(pi);
  registerOverwriteGuard(pi);

  // Register the tool — the edit override wins over the built-in by name.
  registerEditTool(pi, { registry: staleReadHandles.registry });
  registerUndoTool(pi);

  // Register commands
  registerEditGuardCommand(pi, stormbreakerHandles);

  // Reload config on session start so hooks pick up file / env changes.
  pi.on("session_start", async (_event, ctx) => {
    refreshConfig(ctx.cwd);
    // Session-start recovery: flush any events recorded before the session
    // log was ready. This replaces the old drain() loop — pending is the
    // authoritative buffer now; the ring buffer is retained for tests.
    telemetry.flushNow();
  });

  // ── Lifecycle checkpoint flushes ─────────────────────────────────────
  // Pending telemetry is written as ONE edit-guard:event entry per
  // checkpoint; flushNow() is idempotent when nothing is pending.
  //
  // OWNERSHIP RULE — input, session_before_tree, session_before_fork and
  // session_before_compact are all DECISION events in pi (each has a Result
  // type; the first handler returning a defined value decides the outcome).
  // Our listeners are pure observers: they flush and return undefined. Never
  // add a return value to checkpointFlush — that would silently start
  // owning turn/branch/compaction decisions.
  const checkpointFlush = (): void => {
    telemetry.flushNow();
  };
  pi.on("input", checkpointFlush);
  pi.on("agent_settled", checkpointFlush);
  pi.on("agent_end", checkpointFlush);
  pi.on("session_before_tree", checkpointFlush);
  pi.on("session_before_fork", checkpointFlush);
  // Flush before compaction so events land before the compaction entry.
  pi.on("session_before_compact", checkpointFlush);

  // Clear module-level in-memory state on session shutdown so it does not
  // bleed across sessions. The undo dump store is deliberately NOT cleared:
  // undo records survive sessions by design and are bounded by FIFO eviction
  // instead (see src/history/store.ts).
  pi.on("session_shutdown", async () => {
    telemetry.flushNow();
    repairLifecycle.clear();
  });
};
