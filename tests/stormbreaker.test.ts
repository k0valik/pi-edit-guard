import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createStormBreakerState,
  tryEnhanceError,
  extractResultText,
  recordFailure,
  clearFailures,
  incrementPerTool,
  MAX_WINDOW_SIZE,
} from "../src/resilience/stormbreaker.js";
import { errorSignature, enhanceError } from "../src/resilience/enhance.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPiMock, makeCtx } from "../packages/pi-base/src/pi-mock.js";
import { buildRetryGuidance, registerStormBreaker } from "../src/platform/hooks/stormbreaker.js";
import { refreshConfig } from "../src/config/settings.js";
import { telemetry, type GuardEvent } from "../src/telemetry.js";

describe("errorSignature", () => {
  it("normalizes paths", () => {
    const sig1 = errorSignature("edit", "Error: open /foo/bar.txt: no such file");
    const sig2 = errorSignature("edit", "Error: open /baz/qux.txt: no such file");
    expect(sig1).toBe(sig2);
  });

  it("normalizes line numbers", () => {
    const sig1 = errorSignature("edit", "Error at line 5: something");
    const sig2 = errorSignature("edit", "Error at line 10: something");
    expect(sig1).toBe(sig2);
  });

  it("includes tool name", () => {
    const sig = errorSignature("patch", "some error");
    expect(sig.startsWith("patch:")).toBe(true);
  });
});

describe("tryEnhanceError", () => {
  it("enhances no-such-file errors", () => {
    const enhanced = tryEnhanceError("edit", "Error: open /foo/bar.txt: no such file");
    expect(enhanced).toContain("does not exist");
    expect(enhanced).toContain("Check the path");
  });

  it("enhances permission denied", () => {
    const enhanced = tryEnhanceError("read", "Error: permission denied /foo/bar.txt");
    expect(enhanced).toContain("permissions");
  });

  it("passes through unmatched errors", () => {
    const text = "Some random error";
    const enhanced = tryEnhanceError("tool", text);
    expect(enhanced).toBe(`[tool] ${text}`);
  });
});

describe("extractResultText", () => {
  it("extracts from string", () => {
    expect(extractResultText("plain error")).toBe("plain error");
  });

  it("extracts from content array", () => {
    const result = {
      content: [{ type: "text", text: "Error message" }],
    };
    expect(extractResultText(result)).toBe("Error message");
  });

  it("extracts from error property", () => {
    expect(extractResultText({ error: "something failed" })).toBe("something failed");
  });

  it("returns empty string for empty result", () => {
    expect(extractResultText(null)).toBe("");
    expect(extractResultText(undefined)).toBe("");
  });
});

describe("recordFailure — sliding window", () => {
  const now = 1_700_000_000_000;
  const record = (
    state: ReturnType<typeof createStormBreakerState>,
    tool: string,
    sig: string,
    call: string,
    threshold = 3,
  ) => recordFailure(state, tool, sig, "error text", call, threshold, now);

  it("starts at count 1 for a new signature", () => {
    const state = createStormBreakerState();
    const result = record(state, "edit", "sig1", "call-1");
    expect(result.count).toBe(1);
    expect(result.thresholdReached).toBe(false);
    expect(state.windows.get("edit")?.length).toBe(1);
  });

  it("increments count for the same signature", () => {
    const state = createStormBreakerState();
    record(state, "edit", "sig1", "call-1");
    const result = record(state, "edit", "sig1", "call-2");
    expect(result.count).toBe(2);
    expect(result.thresholdReached).toBe(false);
  });

  it("counts only matching signatures within the window (A,B,A,B,A catches the escape)", () => {
    const state = createStormBreakerState();
    // A,B,A,B,A — never consecutive, but A reaches 3 within the window.
    record(state, "edit", "sigA", "call-1");
    record(state, "edit", "sigB", "call-2");
    record(state, "edit", "sigA", "call-3");
    record(state, "edit", "sigB", "call-4");
    const result = record(state, "edit", "sigA", "call-5");
    expect(result.count).toBe(3);
    expect(result.thresholdReached).toBe(true);
  });

  it("separates windows per tool", () => {
    const state = createStormBreakerState();
    record(state, "edit", "sig1", "call-1");
    const result = record(state, "write", "sig1", "call-2");
    expect(result.count).toBe(1); // write window has its own entry
    expect(state.windows.get("edit")?.length).toBe(1);
    expect(state.windows.get("write")?.length).toBe(1);
  });

  it("reports threshold reached when count >= threshold", () => {
    const state = createStormBreakerState();
    record(state, "edit", "sig1", "call-1");
    record(state, "edit", "sig1", "call-2");
    const result = record(state, "edit", "sig1", "call-3");
    expect(result.count).toBe(3);
    expect(result.thresholdReached).toBe(true);
  });

  it("bounded by MAX_WINDOW_SIZE (old failures age out)", () => {
    const state = createStormBreakerState();
    // Fill the window with sig1, then push MAX_WINDOW_SIZE other failures
    for (let i = 0; i < MAX_WINDOW_SIZE; i++) record(state, "edit", "sig1", `call-${i}`);
    for (let i = 0; i < MAX_WINDOW_SIZE; i++) record(state, "edit", "other", `other-${i}`);
    // sig1 is fully aged out of the window
    const result = record(state, "edit", "sig1", "again");
    expect(state.windows.get("edit")?.length).toBe(MAX_WINDOW_SIZE);
    expect(result.count).toBe(1);
  });

  it("clearFailures resets the tool's window (success breaks the streak)", () => {
    const state = createStormBreakerState();
    record(state, "edit", "sig1", "call-1");
    record(state, "edit", "sig1", "call-2");
    clearFailures(state, "edit");
    expect(state.windows.has("edit")).toBe(false);
    const result = record(state, "edit", "sig1", "call-3");
    expect(result.count).toBe(1);
  });

  it("tracks errorsEnhanced and loopsBroken counters", () => {
    const state = createStormBreakerState();
    expect(state.errorsEnhanced).toBe(0);
    expect(state.loopsBroken).toBe(0);
    expect(state.windows.size).toBe(0);
  });
});

describe("registerStormBreaker hook", () => {
  it("does not count Operation aborted toward the failure window", async () => {
    vi.stubEnv("EDIT_GUARD_STORMBREAKER_AUTO_CONTINUE", "0");
    refreshConfig();
    try {
      const pi = createPiMock();
      const handles = registerStormBreaker(pi as unknown as ExtensionAPI);
      const ctx = makeCtx({ abort: vi.fn() });

      // 3 aborted reads in a row — same signature, but aborts are ignored.
      for (let i = 1; i <= 3; i++) {
        await pi.emit(
          "tool_execution_end",
          {
            toolName: "read",
            isError: true,
            result: { content: [{ type: "text", text: "[read] Operation aborted" }] },
            toolCallId: `call-${i}`,
          },
          ctx,
        );
      }

      const failReal = (callId: string) =>
        pi.emit(
          "tool_execution_end",
          {
            toolName: "read",
            isError: true,
            result: { content: [{ type: "text", text: "Path /foo/bar.txt does not exist" }] },
            toolCallId: callId,
          },
          ctx,
        );

      // If aborts polluted the window, these two real failures would already
      // have crossed the threshold and broken the loop.
      await failReal("real-1");
      await failReal("real-2");
      expect(handles.getStats().loopsBroken).toBe(0);

      // Third real failure reaches the threshold — real errors still count
      // normally from an unpolluted window.
      await failReal("real-3");
      expect(handles.getStats().loopsBroken).toBe(1);
    } finally {
      vi.unstubAllEnvs();
      // Re-snapshot: refreshConfig() cached the stubbed value above, and
      // later tests rely on the default-on config without refreshing.
      refreshConfig();
    }
  });

  it("does not abort the session on repeated aborted operations", async () => {
    const pi = createPiMock();
    const handles = registerStormBreaker(pi as unknown as ExtensionAPI);
    const ctx = makeCtx();
    for (let i = 0; i < 10; i++) {
      await pi.emit(
        "tool_execution_end",
        {
          toolName: "read",
          isError: true,
          result: { content: [{ type: "text", text: "Operation aborted" }] },
          toolCallId: `call-${i}`,
        },
        ctx,
      );
    }

    expect(handles.getStats().loopsBroken).toBe(0);
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });
  it("clears the window on break so a persistent error cannot re-break immediately", async () => {
    vi.stubEnv("EDIT_GUARD_STORMBREAKER_AUTO_CONTINUE", "0");
    refreshConfig();
    try {
      const pi = createPiMock();
      const handles = registerStormBreaker(pi as unknown as ExtensionAPI);
      const ctx = makeCtx({ abort: vi.fn() });

      const fail = (callId: string) =>
        pi.emit(
          "tool_execution_end",
          {
            toolName: "read",
            isError: true,
            result: { content: [{ type: "text", text: "Path /foo/bar.txt does not exist" }] },
            toolCallId: callId,
          },
          ctx,
        );

      // First streak of 3 breaks the loop...
      await fail("a1");
      await fail("a2");
      await fail("a3");
      expect(handles.getStats().loopsBroken).toBe(1);

      // ...and the window resets with it: the next identical failure starts
      // a NEW streak (count 1) and must not re-cross the threshold, or
      // auto-continue would turn a persistent error into an endless cycle.
      await fail("a4");
      expect(handles.getStats().loopsBroken).toBe(1);
    } finally {
      vi.unstubAllEnvs();
      refreshConfig();
    }
  });
});

describe("incrementPerTool", () => {
  it("increments errorsEnhanced per tool", () => {
    const state = createStormBreakerState();
    incrementPerTool(state, "edit", "errorsEnhanced");
    incrementPerTool(state, "edit", "errorsEnhanced");
    incrementPerTool(state, "patch", "errorsEnhanced");
    expect(state.perTool.get("edit")!.errorsEnhanced).toBe(2);
    expect(state.perTool.get("patch")!.errorsEnhanced).toBe(1);
  });

  it("increments loopsBroken per tool", () => {
    const state = createStormBreakerState();
    incrementPerTool(state, "edit", "loopsBroken");
    incrementPerTool(state, "edit", "loopsBroken");
    expect(state.perTool.get("edit")!.loopsBroken).toBe(2);
  });

  it("tracks both kinds independently per tool", () => {
    const state = createStormBreakerState();
    incrementPerTool(state, "edit", "errorsEnhanced");
    incrementPerTool(state, "edit", "loopsBroken");
    const stats = state.perTool.get("edit")!;
    expect(stats.errorsEnhanced).toBe(1);
    expect(stats.loopsBroken).toBe(1);
  });
});

describe("errorSignature — collision resistance", () => {
  it("does not collapse distinct errors that share a long boilerplate prefix", () => {
    const head = (
      "[E_EDIT_NOT_FOUND] edits[0]: SEARCH text not found in file. " +
      "Closest candidate at lines 10-40 (similarity 0.82). "
    ).repeat(3);
    const a = head + "Query began: alpha-bravo-charlie-delta";
    const b = head + "Query began: echo-foxtrot-golf-hotel";
    // Pre-fix both truncated to the identical 200-char head.
    expect(errorSignature("edit", a)).not.toBe(errorSignature("edit", b));
  });
});

describe("enhanceError — empty-path detection", () => {
  it("still flags an actually-empty path argument", () => {
    const out = enhanceError("read", "ENOENT: no such file or directory, open ''");
    expect(out).toContain("path");
  });

  it("flags JSON args with an empty path field", () => {
    const out = enhanceError("read", 'Error: no such file or directory. Args: {"path": ""}');
    expect(out).toContain("path");
  });

  it("does NOT blame the path when quotes appear elsewhere in the message", () => {
    const out = enhanceError(
      "edit",
      'Error: no such file or directory — oldText resolved to "" in edits[2]',
    );
    expect(out).not.toContain("'path' argument is empty");
  });
});

describe("registerStormBreaker tool_result content preservation", () => {
  it("keeps non-text blocks when enhancing a multi-block error result", async () => {
    const pi = createPiMock();
    registerStormBreaker(pi as unknown as ExtensionAPI);

    const returned = (await pi.emit("tool_result", {
      isError: true,
      toolName: "read",
      content: [
        { type: "text", text: "Path /foo/missing.txt does not exist" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        { type: "text", text: "secondary context" },
      ],
    })) as { content?: Array<{ type: string; text?: string }> } | undefined;

    expect(returned).toBeDefined();
    // Text blocks collapse into ONE enhanced block; non-text blocks are
    // preserved after it instead of being silently dropped.
    expect(returned!.content).toHaveLength(2);
    expect(returned!.content![0].type).toBe("text");
    expect(returned!.content![0].text).toContain("does not exist");
    expect(returned!.content![0].text).toContain("secondary context");
    expect(returned!.content![1]).toEqual({
      type: "image",
      data: "aGVsbG8=",
      mimeType: "image/png",
    });
  });
});

describe("buildRetryGuidance wording", () => {
  it("restates the failed tool and failure count for edit, with anchored-edit steps", () => {
    const msg = buildRetryGuidance("edit", 3);
    expect(msg).toContain("`edit`");
    expect(msg).toContain("last 3");
    expect(msg).toContain("anchor");
    expect(msg).toContain("Re-read");
    expect(msg).not.toContain("Re-think the command");
  });

  it("uses bash-specific guidance for bash failures", () => {
    const msg = buildRetryGuidance("bash", 4);
    expect(msg).toContain("`bash`");
    expect(msg).toContain("last 4");
    expect(msg).toContain("Re-think the command");
    expect(msg).not.toContain("anchored edit");
  });

  it("falls back to generic guidance for other tools", () => {
    const msg = buildRetryGuidance("grep", 2);
    expect(msg).toContain("`grep`");
    expect(msg).toContain("Change something material");
    expect(msg).toContain("explain the blocker");
  });

  it("always ends with the stop-condition instruction", () => {
    for (const tool of ["edit", "bash", "read", "write"]) {
      expect(buildRetryGuidance(tool, 3)).toContain("stop retrying and explain the blocker");
    }
  });
});

describe("registerStormBreaker auto-continue", () => {
  // The telemetry singleton outlives individual tests: reset its flush
  // handler and pending buffer after each test so events recorded here
  // cannot leak into (or out of) neighboring suites.
  afterEach(() => {
    telemetry.setFlushHandler(() => {});
    telemetry.flushNow();
  });

  /** Emit `count` identical edit failures to cross the default threshold (3). */
  async function failThreeTimes(pi: ReturnType<typeof createPiMock>, ctx: unknown) {
    for (let i = 0; i < 3; i++) {
      await pi.emit(
        "tool_execution_end",
        {
          toolName: "edit",
          isError: true,
          result: { content: [{ type: "text", text: "Path /x/y.txt does not exist" }] },
          toolCallId: `call-${i}`,
        },
        ctx,
      );
    }
  }

  it("sends a corrective follow-up turn after the retry delay", async () => {
    vi.stubEnv("EDIT_GUARD_STORMBREAKER_AUTO_CONTINUE", "1");
    refreshConfig();
    vi.useFakeTimers();
    try {
      const pi = createPiMock();
      registerStormBreaker(pi as unknown as ExtensionAPI);
      const ctx = makeCtx({ abort: vi.fn() });

      // Clear prior noise BEFORE installing the capture handler — earlier
      // tests leave events in the singleton's pending buffer, and draining
      // them into `captured` would poison the assertions below.
      telemetry.flushNow();
      const captured: GuardEvent[] = [];
      telemetry.setFlushHandler((batch) => captured.push(...batch));

      await failThreeTimes(pi, ctx);

      // Only the immediate loop-break notice so far — no retry yet.
      expect(pi.sendMessage).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(3000);

      expect(pi.sendMessage).toHaveBeenCalledTimes(2);
      const [msg, opts] = (pi.sendMessage as unknown as ReturnType<typeof vi.fn>).mock.calls[1] as [
        { customType: string; content: string; display: boolean; details: Record<string, unknown> },
        Record<string, unknown>,
      ];
      expect(opts).toEqual({ triggerTurn: true, deliverAs: "followUp" });
      expect(msg.customType).toBe("edit-guard:stormbreaker");
      expect(msg.display).toBe(true);
      expect(msg.content).toContain("`edit`");
      expect(msg.details.phase).toBe("auto-retry");

      // Stormbreaker events now flow through the batched audit trail, not
      // direct edit-guard:stormbreaker appendEntry calls.
      telemetry.flushNow();
      const loopBreak = captured.find((e) => e.type === "stormbreaker.loop_broken");
      expect(loopBreak).toBeDefined();
      expect(loopBreak).toMatchObject({ toolName: "edit", count: 3 });
      expect((loopBreak as { errorExcerpt?: string }).errorExcerpt).toContain("does not exist");

      const autoRetry = captured.find((e) => e.type === "stormbreaker.auto_retry");
      expect(autoRetry).toBeDefined();
      expect(autoRetry).toMatchObject({ toolName: "edit", count: 3, delayMs: expect.any(Number) });

      // No direct edit-guard:stormbreaker entries via appendEntry.
      const entries = (pi.appendEntry as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[]) => c[0] as string,
      );
      expect(entries.filter((t) => t === "edit-guard:stormbreaker").length).toBe(0);
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
      refreshConfig();
    }
  });

  it("does not schedule a retry turn when auto-continue is disabled", async () => {
    vi.stubEnv("EDIT_GUARD_STORMBREAKER_AUTO_CONTINUE", "0");
    refreshConfig();
    vi.useFakeTimers();
    try {
      const pi = createPiMock();
      registerStormBreaker(pi as unknown as ExtensionAPI);
      const ctx = makeCtx({ abort: vi.fn() });

      await failThreeTimes(pi, ctx);
      await vi.advanceTimersByTimeAsync(10000);

      // Only the loop-break notice; no scheduled follow-up turn.
      expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
      refreshConfig();
    }
  });

  it("clamps the delay from env into the 1000-10000 range", async () => {
    vi.stubEnv("EDIT_GUARD_STORMBREAKER_RETRY_DELAY_MS", "999999");
    refreshConfig();
    vi.useFakeTimers();
    // Spy on the global scheduler so we can assert the EXACT delay handed
    // to setTimeout — advancing time alone cannot distinguish a clamped
    // 10000 from any other delay <= 10000 (including an unclamped one).
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const pi = createPiMock();
      registerStormBreaker(pi as unknown as ExtensionAPI);
      const ctx = makeCtx({ abort: vi.fn() });

      await failThreeTimes(pi, ctx);

      const scheduled = setTimeoutSpy.mock.calls.find(
        ([, delay]) => typeof delay === "number" && delay > 0,
      )?.[1];
      expect(scheduled).toBe(10000);

      await vi.advanceTimersByTimeAsync(10000);
      expect(pi.sendMessage).toHaveBeenCalledTimes(2);
    } finally {
      setTimeoutSpy.mockRestore();
      vi.useRealTimers();
      vi.unstubAllEnvs();
      refreshConfig();
    }
  });
});
