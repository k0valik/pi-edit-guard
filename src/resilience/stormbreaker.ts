/**
 * Storm-breaker core — pure functions for error enhancement and
 * sliding-window failure tracking. No Pi imports.
 *
 * Two responsibilities:
 *
 * 1. Enhance tool error messages so the model gets actionable diagnostics
 *    instead of cryptic OS errors.
 *
 * 2. Track failure signatures in a per-tool sliding window and report when
 *    any single signature reaches the threshold within the window — so
 *    interleaved escapes (A,B,A,B,A) are caught, not just consecutive
 *    repeats (A,A,A). Success clears the window for that tool.
 */

import { enhanceError, extractErrorText } from "./enhance.js";

/** Per-tool failure window cap: the last N failures per tool are considered. */
export const MAX_WINDOW_SIZE = 10;

/** One failure entry in a tool's sliding window. */
export interface WindowedFailure {
  /** Normalized error signature (paths/lines/hex normalized away). */
  signature: string;
  /** When the failure occurred (ms epoch). */
  timestamp: number;
  /** The tool call that failed. */
  toolCallId: string;
  /** Truncated raw error text (audit trail only). */
  error: string;
}

/**
 * Storm-breaker runtime state (mutable, shared across event handlers).
 */
export interface StormBreakerState {
  /** Per-tool sliding window of recent failures (last MAX_WINDOW_SIZE each). */
  windows: Map<string, WindowedFailure[]>;
  /** Total loops broken. */
  loopsBroken: number;
  /** Total errors enhanced. */
  errorsEnhanced: number;
  /** Per-tool breakdown: toolName → { errorsEnhanced, loopsBroken }. */
  perTool: Map<string, { errorsEnhanced: number; loopsBroken: number }>;
}

/** Per-tool stats entry. */
export interface PerToolStats {
  errorsEnhanced: number;
  loopsBroken: number;
}

/**
 * Create a fresh storm-breaker state.
 */
export function createStormBreakerState(): StormBreakerState {
  return {
    windows: new Map(),
    loopsBroken: 0,
    errorsEnhanced: 0,
    perTool: new Map(),
  };
}

/**
 * Increment per-tool stats.
 */
export function incrementPerTool(
  state: StormBreakerState,
  toolName: string,
  kind: "errorsEnhanced" | "loopsBroken",
): void {
  const existing = state.perTool.get(toolName) ?? {
    errorsEnhanced: 0,
    loopsBroken: 0,
  };
  existing[kind]++;
  state.perTool.set(toolName, existing);
}

/**
 * Try to enhance a tool error. Returns the enhanced text if applicable,
 * or the original text if no enhancement pattern matched.
 */
export function tryEnhanceError(toolName: string, errorText: string): string {
  const enhanced = enhanceError(toolName, errorText);
  if (enhanced === errorText) return errorText;
  return enhanced;
}

/**
 * Extract the result text from a tool_execution_end event result.
 * Pure function extracted for testing.
 */
export function extractResultText(result: unknown): string {
  if (typeof result === "string") return result;
  const resultAny = result as Record<string, unknown> | undefined;
  if (!resultAny) return "";
  if (resultAny.content) {
    return extractErrorText(
      Array.isArray(resultAny.content)
        ? (resultAny.content as { type: string; text?: string }[])
        : [{ type: "text", text: String(resultAny.content) }],
    );
  }
  if (resultAny.error) return String(resultAny.error);
  if (resultAny.message) return String(resultAny.message);
  return "";
}

/**
 * Record a failure in the tool's sliding window and report whether the
 * threshold is reached for its signature. The window keeps the last
 * MAX_WINDOW_SIZE failures per tool; the count is the number of those that
 * share the given signature — so A,B,A,B,A reaches the threshold for A even
 * though the failures were never consecutive.
 */
export function recordFailure(
  state: StormBreakerState,
  toolName: string,
  signature: string,
  errorText: string,
  toolCallId: string,
  threshold: number,
  now: number,
): { thresholdReached: boolean; count: number } {
  const window = state.windows.get(toolName) ?? [];
  window.push({
    signature,
    timestamp: now,
    toolCallId,
    error: errorText.slice(0, 300),
  });
  while (window.length > MAX_WINDOW_SIZE) window.shift();
  state.windows.set(toolName, window);

  const count = window.filter((f) => f.signature === signature).length;
  return { thresholdReached: count >= threshold, count };
}

/** Clear the failure window for a tool (called on any success). */
export function clearFailures(state: StormBreakerState, toolName: string): void {
  state.windows.delete(toolName);
}
