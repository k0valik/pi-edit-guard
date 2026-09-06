import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOutsideCwdAdvisory } from "../src/guards/workspace/advisory.js";
import { telemetry } from "../src/telemetry.js";
import { getConfig } from "../src/config/settings.js";

describe("outside-cwd advisory (RED)", () => {
  let dir: string;
  let outside: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "advisory-red-"));
    outside = mkdtempSync(join("/var/tmp", "advisory-red-outside-"));
    telemetry.drain();
  });

  it("returns advisory string when path is outside cwd and toggle is on", async () => {
    (getConfig() as any).outsideCwdAdvisoryEnabled = true;
    const file = join(outside, "file.txt");
    const advisory = await getOutsideCwdAdvisory(
      { cwd: dir },
      { toolName: "edit", absolutePath: file },
    );
    expect(advisory).toBeDefined();
    expect(advisory).toContain("[ADVISORY]");
    expect(advisory).toContain("edit");
    expect(advisory).toContain("outside the scope of the cwd");
  });

  it("returns undefined when path is inside cwd", async () => {
    (getConfig() as any).outsideCwdAdvisoryEnabled = true;
    const file = join(dir, "inside.txt");
    const advisory = await getOutsideCwdAdvisory(
      { cwd: dir },
      { toolName: "edit", absolutePath: file },
    );
    expect(advisory).toBeUndefined();
  });

  it("returns undefined when toggle is off even outside cwd", async () => {
    (getConfig() as any).outsideCwdAdvisoryEnabled = false;
    const file = join(outside, "file.txt");
    const advisory = await getOutsideCwdAdvisory(
      { cwd: dir },
      { toolName: "edit", absolutePath: file },
    );
    expect(advisory).toBeUndefined();
    (getConfig() as any).outsideCwdAdvisoryEnabled = true;
  });

  it("returns undefined when ctx is undefined", async () => {
    const advisory = await getOutsideCwdAdvisory(undefined, {
      toolName: "edit",
      absolutePath: "/tmp/foo.txt",
    });
    expect(advisory).toBeUndefined();
  });

  it("emits path.advisory telemetry when advisory is produced", async () => {
    (getConfig() as any).outsideCwdAdvisoryEnabled = true;
    telemetry.drain();
    const file = join(outside, "tele.txt");
    await getOutsideCwdAdvisory({ cwd: dir }, { toolName: "edit", absolutePath: file });
    const events = telemetry.drain();
    const advisoryEvents = events.filter((e) => (e as any).type === "path.advisory");
    expect(advisoryEvents).toHaveLength(1);
    expect(advisoryEvents[0]).toMatchObject({ toolName: "edit", path: file });
  });

  it("does not emit telemetry when advisory suppressed by toggle", async () => {
    (getConfig() as any).outsideCwdAdvisoryEnabled = false;
    telemetry.drain();
    const file = join(outside, "tele2.txt");
    await getOutsideCwdAdvisory({ cwd: dir }, { toolName: "edit", absolutePath: file });
    const events = telemetry.drain();
    expect(events.filter((e) => (e as any).type === "path.advisory")).toHaveLength(0);
    (getConfig() as any).outsideCwdAdvisoryEnabled = true;
  });
});
