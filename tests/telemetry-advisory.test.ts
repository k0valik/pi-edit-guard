import { describe, it, expect } from "vitest";
import { EditGuardTelemetry } from "../src/telemetry.js";

describe("telemetry path.advisory (RED)", () => {
  it("records path.advisory and increments pathAdvisoryCount", () => {
    const t = new EditGuardTelemetry();
    t.record({
      type: "path.advisory",
      timestamp: Date.now(),
      toolName: "edit",
      path: "/tmp/outside.txt",
    });
    const stats = t.stats();
    expect((stats as any).pathAdvisoryCount).toBe(1);
    const drained = t.drain();
    expect(drained.some((e) => e.type === "path.advisory")).toBe(true);
  });

  it("does not throw for unknown event -> but path.advisory must be handled", () => {
    const t = new EditGuardTelemetry();
    expect(() =>
      t.record({
        type: "path.advisory",
        timestamp: Date.now(),
        toolName: "ls",
        path: "/outside/file.txt",
      }),
    ).not.toThrow();
  });
});
