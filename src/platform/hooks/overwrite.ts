/**
 * Overwrite guard hook registration.
 *
 * Intercepts `write` tool calls and blocks overwrites of existing non-empty
 * files. The first attempt per file per session is blocked with a nudge
 * message; the second attempt (same file, same session) is allowed through.
 * Hooks are always registered; config is read dynamically inside handlers
 * so toggling the guard in settings takes effect without a reload.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { OverwriteGuard } from "../../guards/overwrite/guard.js";
import { getConfig } from "../../config/settings.js";
import { telemetry } from "../../telemetry.js";

export function registerOverwriteGuard(pi: ExtensionAPI) {
  const guard = new OverwriteGuard();

  pi.on("tool_call", async (event: { toolName: string; input: Record<string, unknown> }) => {
    const cfg = getConfig();
    if (!cfg.overwriteGuardEnabled) return;

    if (event.toolName !== "write") return;

    const input = event.input as { path?: string };
    if (!input.path) return;

    const reason = guard.checkWrite(input.path);
    if (reason) {
      telemetry.record({
        type: "overwrite_guard.blocked",
        timestamp: Date.now(),
        path: input.path,
      });
      return {
        block: true,
        reason,
      };
    }
  });

  pi.on("session_shutdown", async () => {
    guard.reset();
  });

  return { guard };
}
