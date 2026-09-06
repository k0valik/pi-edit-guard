import { describe, it, expect } from "vitest";
import { DEFAULTS, config } from "../src/config/settings.js";
import { readEnv } from "../src/config/env.js";
import { getConfig } from "../src/config/settings.js";

describe("outsideCwdAdvisoryEnabled config (RED)", () => {
  it("outsideCwdAdvisoryEnabled defaults to true", () => {
    expect((DEFAULTS as any).outsideCwdAdvisoryEnabled).toBe(true);
  });

  it("env var EDIT_GUARD_OUTSIDE_CWD_ADVISORY_ENABLED=false disables advisory", () => {
    const prev = process.env.EDIT_GUARD_OUTSIDE_CWD_ADVISORY_ENABLED;
    process.env.EDIT_GUARD_OUTSIDE_CWD_ADVISORY_ENABLED = "false";
    const env = readEnv();
    expect((env as any).outsideCwdAdvisoryEnabled).toBe(false);
    if (prev === undefined) delete process.env.EDIT_GUARD_OUTSIDE_CWD_ADVISORY_ENABLED;
    else process.env.EDIT_GUARD_OUTSIDE_CWD_ADVISORY_ENABLED = prev;
  });

  it("settings modal field exists for outsideCwdAdvisoryEnabled", () => {
    const fields = config.getFields(getConfig());
    const found = fields.find((f) => (f as any).key === "outsideCwdAdvisoryEnabled");
    expect(found).toBeDefined();
    expect((found as any).label).toBe("Outside-CWD Advisory");
  });
});
