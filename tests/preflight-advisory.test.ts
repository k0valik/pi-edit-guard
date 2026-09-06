import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflight } from "../src/guards/preflight/preflight.js";

describe("preflight advisory (RED)", () => {
  it("returns advisory when existing path is outside cwd", () => {
    const cwd = mkdtempSync(join(tmpdir(), "preflight-cwd-"));
    const outside = mkdtempSync(join("/var/tmp", "preflight-outside-"));
    const outsideFile = join(outside, "file.txt");
    writeFileSync(outsideFile, "hello");

    const outcome = preflight({ toolName: "read", input: { path: outsideFile }, cwd });
    expect(outcome.kind).toBe("advisory");
    if (outcome.kind === "advisory") {
      expect(outcome.reason).toContain("outside");
    }

    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("returns pass when path is inside cwd", () => {
    const cwd = mkdtempSync(join(tmpdir(), "preflight-cwd2-"));
    const insideFile = join(cwd, "inside.txt");
    writeFileSync(insideFile, "hello");

    const outcome = preflight({ toolName: "read", input: { path: insideFile }, cwd });
    expect(outcome.kind).toBe("pass");

    rmSync(cwd, { recursive: true, force: true });
  });

  it("still blocks non-existent paths", () => {
    const cwd = mkdtempSync(join(tmpdir(), "preflight-cwd3-"));
    const outcome = preflight({ toolName: "read", input: { path: "/nonexistent/xyz.txt" }, cwd });
    expect(outcome.kind).toBe("block");
    rmSync(cwd, { recursive: true, force: true });
  });

  it("carries the alias repair on the advisory outcome instead of dropping it", () => {
    const cwd = mkdtempSync(join(tmpdir(), "preflight-cwd4-"));
    const outside = mkdtempSync(join("/var/tmp", "preflight-repair-outside-"));
    const outsideFile = join(outside, "file.txt");
    writeFileSync(outsideFile, "hello");

    const outcome = preflight({ toolName: "read", input: { file_path: outsideFile }, cwd });
    expect(outcome.kind).toBe("advisory");
    if (outcome.kind === "advisory") {
      expect(outcome.repair).toEqual({
        kind: "renamed",
        aliasKey: "file_path",
        value: outsideFile,
      });
    }

    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("carries quote/whitespace normalization on the advisory outcome", () => {
    const cwd = mkdtempSync(join(tmpdir(), "preflight-quoted-cwd-"));
    const outside = mkdtempSync(join("/var/tmp", "preflight-quoted-outside-"));
    const outsideFile = join(outside, "file.txt");
    writeFileSync(outsideFile, "hello");

    const outcome = preflight({ toolName: "write", input: { path: `  "${outsideFile}"  ` }, cwd });
    expect(outcome.kind).toBe("advisory");
    if (outcome.kind === "advisory") {
      expect(outcome.repair).toEqual({ kind: "normalized", key: "path", value: outsideFile });
    }

    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
});
