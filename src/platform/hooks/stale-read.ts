/**
 * Stale-read observer hook registration.
 *
 * Tracks file reads and rejects edits to files that changed since the last read.
 * Hooks are always registered; config is read dynamically inside handlers
 * so toggling stale-read in settings takes effect without a reload.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { statSync, readFileSync } from "node:fs";
import { ReadRegistry } from "../../guards/stale-read/registry.js";
import { getConfig } from "../../config/settings.js";
import { telemetry } from "../../telemetry.js";

export function registerStaleReadObserver(pi: ExtensionAPI) {
  const registry = new ReadRegistry({
    toleranceMs: getConfig().staleReadToleranceMs,
    stat: (path: string) => {
      try {
        const s = statSync(path);
        return { mtimeMs: s.mtimeMs };
      } catch {
        return { mtimeMs: -1 };
      }
    },
    readFile: (path: string) => readFileSync(path, "utf-8"),
  });

  // Record reads when the read tool returns content; self-heal after the
  // agent's OWN successful edit/write so the registry can distinguish its
  // own writes from external modification (read → write → edit must not
  // self-block: without this, the write bumps the mtime and the next edit
  // would be rejected as stale).
  //
  // Self-heal tracking lives HERE, not in the executor's injected callback:
  // this handler is the single chokepoint that observes every successful
  // mutation (edit/write/undo) exactly once — the executor ALSO refreshes,
  // so counting both would report each heal twice.
  const selfRefreshTracked = (path: string): void => {
    // Check staleness BEFORE refreshing — selfRefresh() clears the warned
    // state, so we must sample first. Only emit telemetry when there was
    // an actual stale condition to heal; the unconditional emit inflated
    // stale_read.self_healed counts to ~1 per edit call.
    const wasStale = !registry.isFresh(path);
    registry.selfRefresh(path);
    if (wasStale) {
      telemetry.record({
        type: "stale_read.self_healed",
        timestamp: Date.now(),
        path,
      });
    }
  };

  pi.on("tool_result", async (event, ctx) => {
    const cfg = getConfig();
    if (!cfg.staleReadEnabled) return;
    if (ctx?.cwd) registry.setBaseDir(ctx.cwd);
    if (event.isError) return;
    const input = event.input as { path?: string };
    if (!input.path) return;

    if (event.toolName === "read") {
      registry.record(input.path);
    } else if (
      event.toolName === "edit" ||
      event.toolName === "write" ||
      event.toolName === "undo"
    ) {
      selfRefreshTracked(input.path);
    }
  });

  // Check staleness before edit execution
  pi.on("tool_call", async (event, ctx) => {
    const cfg = getConfig();
    if (!cfg.staleReadEnabled) return;
    if (ctx?.cwd) registry.setBaseDir(ctx.cwd);
    registry.setToleranceMs(cfg.staleReadToleranceMs);

    if (event.toolName !== "edit") {
      return;
    }

    const input = event.input as {
      path?: string;
      edits?: Array<{ oldText?: unknown }>;
    };
    if (!input.path) return;

    // Forward the edit's search texts: when they ALL still match the current
    // content verbatim, the splice is provably applicable and staleness of
    // unrelated regions must not hard-block (mined 2026-08-18, commit.md).
    const oldTexts = Array.isArray(input.edits)
      ? input.edits
          .map((e) => (typeof e?.oldText === "string" ? e.oldText : ""))
          .filter((t) => t.length > 0)
      : [];

    const error = registry.assertFresh(input.path, { oldTexts });
    if (!error) return;

    if (error.kind === "stale-read-warning") {
      // Advisory flows through to the tool result via getStaleWarning();
      // blocking here would push models to sed/cat workarounds.
      return;
    }

    telemetry.record({
      type: "stale_read.blocked",
      timestamp: Date.now(),
      path: input.path,
    });
    return {
      block: true,
      reason: error.message,
    };
  });

  // Clear on session shutdown
  pi.on("session_shutdown", async () => {
    registry.reset();
  });

  // Only the registry is consumed externally (extension.ts injects it into
  // the edit tool). Self-heal counting deliberately lives in the tool_result
  // handler above — exposing a tracked wrapper here would invite the double
  // count it was removed to prevent. record/isFresh stay as test conveniences.
  return {
    registry,
    record: (path: string) => registry.record(path),
    isFresh: (path: string) => registry.isFresh(path),
  };
}
