/**
 * Path preflight hook registration.
 *
 * Validates and normalizes paths before tool execution. The hook fires for
 * exactly the PATH_TOOLS set (read/edit/write/ls/grep/find — preflight()
 * itself passes everything else through). Normalization MUTATES event.input
 * in place — tool_call return values only control blocking (pi guarantees
 * mutations to event.input affect actual tool execution). The old
 * `{ input }` return was silently discarded (confirmed dead in recon):
 * in-place mutation is the only reliable way to rewrite paths.
 * Blocks (non-existent path) keep the "did you mean" suggestions.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { preflight, type PathRepair } from "../../guards/preflight/preflight.js";
import { getConfig } from "../../config/settings.js";
import { telemetry } from "../../telemetry.js";
import { ADVISORY_OWNING_TOOLS } from "../../guards/workspace/advisory.js";

/**
 * In-place argument repair shared by the renamed/normalized outcomes and the
 * advisory outcome (which may co-occur with a repair). Mutation is the effect
 * — pi guarantees mutations to event.input affect actual tool execution.
 */
function applyPathRepair(input: Record<string, unknown>, repair: PathRepair): void {
  if (repair.kind === "renamed") {
    // Alias repair: native schemas demand `path`. Delete the alias key so
    // validation accepts the call.
    delete input[repair.aliasKey];
    input.path = repair.value;
  } else {
    input[repair.key] = repair.value;
  }
}

export function registerPreflight(pi: ExtensionAPI) {
  pi.on(
    "tool_call",
    async (event: { toolName: string; input: Record<string, unknown> }, ctx: ExtensionContext) => {
      const cfg = getConfig();
      if (!cfg.preflightEnabled) return;

      const outcome = preflight({
        toolName: event.toolName,
        input: event.input,
        cwd: ctx.cwd,
      });

      if (outcome.kind === "block") {
        telemetry.record({
          type: "preflight.blocked",
          timestamp: Date.now(),
          toolName: event.toolName,
          reason: outcome.reason,
        });
        return {
          block: true,
          reason: outcome.reason,
        };
      }

      if (outcome.kind === "advisory") {
        // Capture the raw path BEFORE any repair mutates the input.
        const rawPath =
          (event.input.path as string) ??
          (event.input.file_path as string) ??
          (event.input.filePath as string) ??
          "<unknown>";
        // A repair (alias rename / quote-whitespace normalization) may ride
        // on the advisory outcome. Apply it BEFORE the toggle/ownership
        // gates: the repair is preflight's core job and must happen even
        // when the advisory text is suppressed or tool-owned — otherwise the
        // tool receives the raw malformed path and fails on top of the
        // advisory, wasting turns.
        if (outcome.repair) {
          telemetry.record({
            type: "preflight.normalized",
            timestamp: Date.now(),
            toolName: event.toolName,
          });
          applyPathRepair(event.input, outcome.repair);
        }
        if (!cfg.outsideCwdAdvisoryEnabled) return undefined;
        // Tools that inject the advisory text themselves (currently `edit`,
        // via getOutsideCwdAdvisory) own their path.advisory telemetry —
        // recording here too would emit TWO events per outside-cwd call and
        // double-count pathAdvisoryCount. The hook is the single source only
        // for tools that cannot inject result text (write, read-style).
        if (ADVISORY_OWNING_TOOLS.has(event.toolName)) return undefined;
        telemetry.record({
          type: "path.advisory",
          timestamp: Date.now(),
          toolName: event.toolName,
          path: rawPath,
        });
        // Advisory is non-blocking — allow the tool to proceed. The
        // advisory text injection for read tools requires tool overrides
        // (see plan §8); preflight alone cannot inject result text.
        return undefined;
      }

      if (outcome.kind === "renamed") {
        telemetry.record({
          type: "preflight.normalized",
          timestamp: Date.now(),
          toolName: event.toolName,
        });
        applyPathRepair(event.input, outcome);
        return undefined;
      }

      if (outcome.kind === "normalized") {
        telemetry.record({
          type: "preflight.normalized",
          timestamp: Date.now(),
          toolName: event.toolName,
        });
        applyPathRepair(event.input, outcome);
      }

      return undefined;
    },
  );
}
