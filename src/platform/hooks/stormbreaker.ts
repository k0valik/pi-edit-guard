/**
 * Stormbreaker hook registration.
 *
 * Enhances tool error messages and breaks repeated-failure loops.
 * Hooks are always registered; config is read dynamically inside each handler
 * so toggling stormbreaker in settings takes effect without a reload.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import type { TextContent } from "@earendil-works/pi-ai";
import {
  createStormBreakerState,
  tryEnhanceError,
  extractResultText,
  recordFailure,
  clearFailures,
  incrementPerTool,
  MAX_WINDOW_SIZE,
} from "../../resilience/stormbreaker.js";
import { extractErrorText, errorSignature } from "../../resilience/enhance.js";
import { getConfig } from "../../config/settings.js";
import { telemetry } from "../../telemetry.js";

export interface StormBreakerHandles {
  getStats(): {
    errorsEnhanced: number;
    loopsBroken: number;
    perTool: Record<string, { errorsEnhanced: number; loopsBroken: number }>;
  };
}

/**
 * Build the corrective retry prompt sent when a broken loop auto-continues.
 *
 * Restates what failed and how often, then gives tool-specific corrective
 * steps — a bare "continue" just reproduces the loop. Pure function so the
 * wording is unit-testable.
 */
export function buildRetryGuidance(toolName: string, count: number): string {
  const header =
    `Stormbreaker paused the session because your last ${count} \`${toolName}\` calls failed ` +
    "with the same error. Auto-resuming now — retry, but fix the cause first.\n\n";

  const editSteps = [
    "Before retrying `edit`:",
    "1. Re-read the part of the file you are editing so you work from its current content, not memory.",
    "2. Copy oldText verbatim from that read - exact whitespace and indentation.",
    "3. If oldText appears more than once in the file, use an anchored edit: set anchor to a unique line copied verbatim from immediately above or below the block being replaced.",
    "4. Keep oldText minimal but unique; merge nearby changes into one edit instead of overlapping edits.",
  ].join("\n");

  const bashSteps = [
    "Before retrying `bash`:",
    "1. Re-think the command: an identical repeat will hit the identical error.",
    "2. Inspect the current state first (list files, print the relevant path or config) instead of assuming it.",
    "3. Run the smallest command that isolates the failure before retrying the full one.",
  ].join("\n");

  const genericSteps = [
    `Before retrying \`${toolName}\`:`,
    "1. Re-verify every argument against the current state (fresh read/list where applicable).",
    "2. Change something material about the call - the exact same arguments will fail the exact same way.",
  ].join("\n");

  const steps = toolName === "edit" ? editSteps : toolName === "bash" ? bashSteps : genericSteps;

  const tail =
    "\n\nIf this attempt fails the same way again, stop retrying and explain the blocker to the user instead.";

  return header + steps + tail;
}

export function registerStormBreaker(pi: ExtensionAPI): StormBreakerHandles {
  const state = createStormBreakerState();

  // ── Hook 1: Enhance tool error messages ─────────────────────────────
  pi.on("tool_result", async (event: ToolResultEvent) => {
    const cfg = getConfig();
    if (!cfg.stormbreakerEnabled) return;
    if (!event.isError) return;

    const errorText = extractErrorText(
      event.content.map((c) => ({
        type: c.type,
        text: "text" in c ? c.text : undefined,
        data: "data" in c ? c.data : undefined,
      })),
    );
    if (!errorText) return;

    const enhanced = tryEnhanceError(event.toolName, errorText);
    if (enhanced === errorText) return;

    state.errorsEnhanced++;
    incrementPerTool(state, event.toolName, "errorsEnhanced");

    telemetry.record({
      type: "stormbreaker.enhanced",
      timestamp: Date.now(),
      toolName: event.toolName,
      count: state.perTool.get(event.toolName)?.errorsEnhanced ?? 1,
    });

    // Text blocks collapse into the enhanced message; non-text blocks
    // (images, attachments) are preserved — returning a flat single-text
    // array used to silently drop them.
    const enhancedBlock: TextContent = { type: "text", text: enhanced };
    return {
      content: [enhancedBlock, ...event.content.filter((c) => c.type !== "text")],
    };
  });

  // ── Hook 2: Track failures in a sliding window and break the loop ──
  pi.on(
    "tool_execution_end",
    async (
      event: {
        toolName: string;
        isError: boolean;
        result: unknown;
        toolCallId: string;
      },
      ctx: ExtensionContext,
    ) => {
      const cfg = getConfig();
      if (!cfg.stormbreakerEnabled) return;

      if (!event.isError) {
        // Success clears the tool's failure window — the streak is broken.
        clearFailures(state, event.toolName);
        return;
      }

      const resultText = extractResultText(event.result);
      const sig = errorSignature(event.toolName, resultText);

      // Aborted operations are external cancellations, not tool-failure loops.
      // Skip them so they don't pollute the sliding window or trigger
      // loop-breaking mid-batch.
      if (/operation aborted/i.test(resultText)) return;

      // Sliding window: any single signature reaching the threshold within
      // the last MAX_WINDOW_SIZE failures triggers the break — catches
      // A,B,A,B,A interleaving escapes that consecutive counting missed.
      const { thresholdReached, count } = recordFailure(
        state,
        event.toolName,
        sig,
        resultText,
        event.toolCallId,
        cfg.stormbreakerThreshold,
        Date.now(),
      );

      if (!thresholdReached) return;

      // ── Threshold reached — break the loop ──────────────────────────
      const toolName = event.toolName;
      state.loopsBroken++;
      incrementPerTool(state, toolName, "loopsBroken");

      // The streak that triggered the break is over — clear the window so
      // the NEXT identical failure starts counting from 1. Without this,
      // auto-continue turns a persistent error into an unbounded
      // abort/retry cycle: every subsequent failure re-crosses the
      // threshold immediately and re-breaks forever.
      clearFailures(state, toolName);

      telemetry.record({
        type: "stormbreaker.loop_broken",
        timestamp: Date.now(),
        toolName,
        count,
        errorExcerpt: resultText.slice(0, 300),
      });

      ctx.abort();

      const message =
        "Unable to continue: tool `" +
        toolName +
        "` failed " +
        count +
        " times with the same error (within the last " +
        MAX_WINDOW_SIZE +
        " calls).\n\nLast error: " +
        (resultText.slice(0, 300) || "unknown error") +
        "\n\nThis usually means the arguments are wrong, or the target doesn't exist.\n" +
        "Please clarify what you'd like me to do, or check the inputs and try again.";

      pi.sendMessage(
        {
          customType: "edit-guard:stormbreaker",
          content: message,
          display: true,
          details: {
            tool: toolName,
            count,
            error: resultText.slice(0, 300),
          },
        },
        { triggerTurn: false },
      );

      ctx.ui.notify(`Stormbreaker: ${toolName} failed ${count}x — loop broken`, "warning");

      // ── Auto-continue ─────────────────────────────────────────────────
      // Instead of parking the session on a user prompt, resume after a
      // short pause with a corrective retry prompt. followUp delivery waits
      // for the aborted run to settle; triggerTurn then starts the retry.
      if (!cfg.stormbreakerAutoContinue) return;

      const retryMessage = buildRetryGuidance(toolName, count);
      const delayMs = cfg.stormbreakerRetryDelayMs;
      const timer = setTimeout(() => {
        try {
          pi.sendMessage(
            {
              customType: "edit-guard:stormbreaker",
              content: retryMessage,
              display: true,
              details: {
                tool: toolName,
                count,
                phase: "auto-retry",
                delayMs,
              },
            },
            { triggerTurn: true, deliverAs: "followUp" },
          );
          // Audit trail parity: an appendEntry for the retry too.
          telemetry.record({
            type: "stormbreaker.auto_retry",
            timestamp: Date.now(),
            toolName,
            count,
            delayMs,
          });
        } catch {
          // Session may have closed during the pause; never crash from the timer.
        }
      }, delayMs);
      // A pending retry must not keep the CLI process alive after the
      // session ends (the callback tolerates a closed session anyway).
      timer.unref();
    },
  );

  return {
    getStats: () => ({
      errorsEnhanced: state.errorsEnhanced,
      loopsBroken: state.loopsBroken,
      perTool: Object.fromEntries(
        [...state.perTool.entries()].map(([tool, stats]) => [
          tool,
          {
            errorsEnhanced: stats.errorsEnhanced,
            loopsBroken: stats.loopsBroken,
          },
        ]),
      ),
    }),
  };
}
