import { describe, it, expect, vi } from "vitest";

vi.mock("../packages/pi-base/src/index.ts", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, openSettingsModal: vi.fn(async () => {}) };
});

import { describeAuditEvent } from "../src/platform/commands/edit-guard/index.js";
import { telemetry } from "../src/telemetry.js";

describe("status advisory (RED)", () => {
  it("describeAuditEvent handles path.advisory", () => {
    const text = describeAuditEvent({
      type: "path.advisory",
      toolName: "edit",
      path: "/tmp/outside.txt",
    });
    expect(text).toContain("outside-cwd advisory");
    expect(text).toContain("edit");
  });

  it("telemetry stats includes pathAdvisoryCount field", () => {
    const t = telemetry;
    // Ensure stats has pathAdvisoryCount property
    const stats: any = t.stats();
    expect(stats).toHaveProperty("pathAdvisoryCount");
  });
});
