import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPiMock, makeCtx } from "../packages/pi-base/src/pi-mock.js";
import { registerEditTool } from "../src/platform/tools/edit.js";
import { getConfig } from "../src/config/settings.js";
import { telemetry } from "../src/telemetry.js";

let dir: string;
let outside: string;
let outsideFile: string;

describe("edit tool advisory (RED)", () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "edit-advisory-test-"));
    outside = mkdtempSync(join("/var/tmp", "edit-advisory-outside-"));
    outsideFile = join(outside, "target.txt");
    writeFileSync(outsideFile, "hello world\n");
    process.env.PI_UNDO_STORE_PATH = join(dir, "undo-store.json");
  });

  afterAll(() => {
    delete process.env.PI_UNDO_STORE_PATH;
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("appends advisory to result text when edit target is outside cwd", async () => {
    (getConfig() as any).outsideCwdAdvisoryEnabled = true;
    telemetry.drain();
    const pi = createPiMock();
    registerEditTool(pi as unknown as ExtensionAPI);
    const tool: any = pi.tools[0];
    const ctx = makeCtx({ cwd: dir });

    writeFileSync(outsideFile, "hello world\n");
    const result = await tool.execute(
      "call-advisory",
      { path: outsideFile, edits: [{ oldText: "hello", newText: "HELLO" }] },
      undefined,
      undefined,
      ctx,
    );

    expect(result.content[0].text).toContain("[ADVISORY]");
    expect(result.content[0].text).toContain("edit fell outside");
    // file still written
    expect(readFileSync(outsideFile, "utf8")).toBe("HELLO world\n");
  });

  it("does not append advisory when path is inside cwd", async () => {
    (getConfig() as any).outsideCwdAdvisoryEnabled = true;
    const pi = createPiMock();
    registerEditTool(pi as unknown as ExtensionAPI);
    const tool: any = pi.tools[0];
    const ctx = makeCtx({ cwd: dir });
    const inside = join(dir, "inside.txt");
    writeFileSync(inside, "hello world\n");

    const result = await tool.execute(
      "call-inside",
      { path: inside, edits: [{ oldText: "hello", newText: "HELLO" }] },
      undefined,
      undefined,
      ctx,
    );

    expect(result.content[0].text).not.toContain("[ADVISORY]");
  });

  it("advisory does not affect details shape", async () => {
    (getConfig() as any).outsideCwdAdvisoryEnabled = true;
    const pi = createPiMock();
    registerEditTool(pi as unknown as ExtensionAPI);
    const tool: any = pi.tools[0];
    const ctx = makeCtx({ cwd: dir });
    writeFileSync(outsideFile, "hello world\n");

    const result = await tool.execute(
      "call-details",
      { path: outsideFile, edits: [{ oldText: "hello", newText: "HELLO" }] },
      undefined,
      undefined,
      ctx,
    );

    expect(result.details).toHaveProperty("diff");
    expect(result.details).toHaveProperty("patch");
    expect(result.details).toHaveProperty("guard");
  });

  it("does not append advisory when toggle is off", async () => {
    (getConfig() as any).outsideCwdAdvisoryEnabled = false;
    const pi = createPiMock();
    registerEditTool(pi as unknown as ExtensionAPI);
    const tool: any = pi.tools[0];
    const ctx = makeCtx({ cwd: dir });
    writeFileSync(outsideFile, "hello world\n");

    const result = await tool.execute(
      "call-off",
      { path: outsideFile, edits: [{ oldText: "hello", newText: "HELLO" }] },
      undefined,
      undefined,
      ctx,
    );

    expect(result.content[0].text).not.toContain("[ADVISORY]");
    (getConfig() as any).outsideCwdAdvisoryEnabled = true;
  });
});
