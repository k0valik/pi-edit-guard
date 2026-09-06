import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPiMock, makeCtx } from "../packages/pi-base/src/pi-mock.js";
import { registerPreflight } from "../src/platform/hooks/preflight.js";
import { preflight } from "../src/guards/preflight/preflight.js";
import { telemetry } from "../src/telemetry.js";
import { getConfig } from "../src/config/settings.js";
import { normalizePathValue, getPathArg } from "../src/guards/preflight/paths.js";
import { nearMatches } from "../src/guards/preflight/suggest.js";

const dir = mkdtempSync(join(tmpdir(), "edit-guard-preflight-"));
const ctxMock = () => makeCtx({ cwd: dir });

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("normalizePathValue", () => {
  it("strips matching quotes", () => {
    expect(normalizePathValue('"foo.txt"')).toBe("foo.txt");
    expect(normalizePathValue("'foo.txt'")).toBe("foo.txt");
  });

  it("preserves unmatched strings", () => {
    expect(normalizePathValue("foo.txt")).toBe("foo.txt");
    expect(normalizePathValue('"foo.txt')).toBe('"foo.txt');
  });

  it("trims whitespace", () => {
    expect(normalizePathValue("  foo.txt  ")).toBe("foo.txt");
  });
});

describe("getPathArg", () => {
  it("extracts path from input", () => {
    const result = getPathArg("read", { path: "/foo/bar.txt" });
    expect(result).not.toBeNull();
    expect(result!.key).toBe("path");
    expect(result!.value).toBe("/foo/bar.txt");
  });

  it("extracts file_path as fallback", () => {
    const result = getPathArg("edit", { file_path: "/foo/bar.txt" });
    expect(result).not.toBeNull();
    expect(result!.key).toBe("file_path");
  });

  it("extracts filePath (camelCase) as fallback", () => {
    // deepseek-v4-pro sent `filePath` five times in one session
    // (2026-08-25); every call died in native validation.
    const result = getPathArg("read", { filePath: "/foo/bar.txt" });
    expect(result).not.toBeNull();
    expect(result!.key).toBe("filePath");
  });

  it("returns null for tools without path arg", () => {
    expect(getPathArg("bash", { command: "ls" })).toBeNull();
  });

  it("returns null for empty path", () => {
    expect(getPathArg("read", { path: "" })).toBeNull();
  });
});

describe("preflight", () => {
  it("passes for valid existing path", () => {
    const outcome = preflight({
      toolName: "read",
      input: { path: __dirname },
      cwd: __dirname,
    });
    expect(outcome.kind).toBe("pass");
  });

  it("normalizes quoted paths", () => {
    const quoted = `"${__dirname}"`;
    const outcome = preflight({
      toolName: "read",
      input: { path: quoted },
      cwd: __dirname,
    });
    expect(outcome.kind).toBe("normalized");
    if (outcome.kind === "normalized") {
      expect(outcome.value).toBe(__dirname);
    }
  });

  it("blocks non-existent paths for read tools", () => {
    const outcome = preflight({
      toolName: "read",
      input: { path: "/nonexistent/path/foo.txt" },
      cwd: __dirname,
    });
    expect(outcome.kind).toBe("block");
    if (outcome.kind === "block") {
      expect(outcome.reason).toContain("does not exist");
    }
  });

  it("passes for write tools (target need not exist) inside cwd", () => {
    const target = join(__dirname, `tmp-write-inside-${Date.now()}.txt`);
    const outcome = preflight({
      toolName: "write",
      input: { path: target },
      cwd: __dirname,
    });
    expect(outcome.kind).toBe("pass");
  });

  it("returns advisory for write tools outside cwd", () => {
    const outcome = preflight({
      toolName: "write",
      input: { path: "/tmp/pi-better-test-12345.txt" },
      cwd: __dirname,
    });
    expect(outcome.kind).toBe("advisory");
    if (outcome.kind === "advisory") {
      expect(outcome.reason).toContain("outside");
    }
  });

  it("returns pass when no path arg", () => {
    const outcome = preflight({
      toolName: "bash",
      input: { command: "ls" },
      cwd: __dirname,
    });
    expect(outcome.kind).toBe("pass");
  });
});

describe("preflight — path-key alias repair", () => {
  it("signals rename for aliased keys even when the value is clean", () => {
    const file = join(dir, "alias-target.txt");
    writeFileSync(file, "x");
    const input: Record<string, unknown> = { offset: 5, filePath: file, limit: 10 };
    const outcome = preflight({ toolName: "read", input, cwd: dir });
    // "pass" would leave the alias key in place and native validation
    // rejects the call (`path: must have required properties path`).
    expect(outcome).toMatchObject({ kind: "renamed", aliasKey: "filePath", value: file });
  });

  it("blocks aliased non-existent paths with near-match suggestions", () => {
    const outcome = preflight({
      toolName: "read",
      input: { file_path: "/definitely/not/here-xyz" },
      cwd: dir,
    });
    expect(outcome.kind).toBe("block");
    if (outcome.kind === "block") {
      expect(outcome.reason).toContain("does not exist");
    }
  });

  it("renames for write tools too (mkdir side effect preserved)", () => {
    const target = join(dir, "alias-write-dir", "fresh.txt");
    const outcome = preflight({ toolName: "write", input: { filePath: target }, cwd: dir });
    expect(outcome).toMatchObject({ kind: "renamed", aliasKey: "filePath", value: target });
  });
});

describe("nearMatches", () => {
  it("finds close filenames", () => {
    const { tmpdir } = require("node:os");
    const { join } = require("node:path");
    const { writeFileSync, unlinkSync } = require("node:fs");
    const target = join(tmpdir(), "pi-better-toolcalls-test-foo.txt");
    writeFileSync(target, "");

    try {
      const matches = nearMatches("pi-better-toolcalls-test-fo.txt", tmpdir());
      expect(matches.length).toBeGreaterThan(0);
    } finally {
      unlinkSync(target);
    }
  });

  it("returns empty for no matches", () => {
    const matches = nearMatches("xyznonexistentfile12345.txt", __dirname);
    expect(matches).toHaveLength(0);
  });
});

describe("registerPreflight hook — in-place normalization + honest scope", () => {
  it("mutates event.input in place when normalizing", async () => {
    const pi = createPiMock();
    registerPreflight(pi as unknown as ExtensionAPI);
    const file = join(dir, "existing.txt");
    writeFileSync(file, "x");

    const input: Record<string, unknown> = { path: `  "${file}"  ` };
    const result = await pi.emit("tool_call", { toolName: "read", input }, ctxMock());

    expect(result).toBeUndefined(); // mutation is the effect, not a return
    expect(input.path).toBe(file); // in place — the OLD { input } return was discarded
  });

  it("renames aliased path keys in place so native validation accepts the call", async () => {
    const pi = createPiMock();
    registerPreflight(pi as unknown as ExtensionAPI);
    const file = join(dir, "aliased.txt");
    writeFileSync(file, "x");

    // Exact shape deepseek-v4-pro sent five times (2026-08-25).
    const input: Record<string, unknown> = { offset: 564, filePath: file, limit: 10 };
    const result = await pi.emit("tool_call", { toolName: "read", input }, ctxMock());

    expect(result).toBeUndefined(); // pass-through — no block
    expect(input.path).toBe(file);
    expect("filePath" in input).toBe(false); // alias removed, not duplicated
  });

  it("blocks non-existent paths for every PATH_TOOLS read-style tool", async () => {
    const pi = createPiMock();
    registerPreflight(pi as unknown as ExtensionAPI);

    for (const toolName of ["read", "edit", "ls", "grep", "find"]) {
      const input: Record<string, unknown> = {
        path: "/definitely/not/here-xyz",
      };
      const result = await pi.emit("tool_call", { toolName, input }, ctxMock());
      expect(result).toMatchObject({ block: true });
      expect((result as { reason?: string }).reason).toContain("does not exist");
    }
  });

  it("records exactly one path.advisory per outside-cwd call (no edit double-count)", async () => {
    const pi = createPiMock();
    registerPreflight(pi as unknown as ExtensionAPI);
    (getConfig() as any).outsideCwdAdvisoryEnabled = true;
    const outside = mkdtempSync(join("/var/tmp", "preflight-advisory-dup-"));
    const outsideFile = join(outside, "file.txt");
    writeFileSync(outsideFile, "x");

    try {
      // edit owns its advisory via getOutsideCwdAdvisory (edit-tool.ts) —
      // the hook must stay silent or pathAdvisoryCount counts 2x.
      telemetry.drain();
      await pi.emit(
        "tool_call",
        { toolName: "edit", input: { path: outsideFile, edits: [] } },
        ctxMock(),
      );
      expect(telemetry.drain().filter((e) => e.type === "path.advisory")).toHaveLength(0);

      // read-style tools have no other source — the hook IS the source.
      await pi.emit("tool_call", { toolName: "read", input: { path: outsideFile } }, ctxMock());
      const advisory = telemetry.drain().filter((e) => e.type === "path.advisory") as Array<{
        type: string;
        toolName: string;
      }>;
      expect(advisory).toHaveLength(1);
      expect(advisory[0].toolName).toBe("read");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("applies the advisory's repair in place even when the advisory is tool-owned (edit)", async () => {
    const pi = createPiMock();
    registerPreflight(pi as unknown as ExtensionAPI);
    (getConfig() as any).outsideCwdAdvisoryEnabled = true;
    const outside = mkdtempSync(join("/var/tmp", "preflight-repair-owned-"));
    const outsideFile = join(outside, "file.txt");
    writeFileSync(outsideFile, "x");

    try {
      const input: Record<string, unknown> = { path: `  "${outsideFile}"  `, edits: [] };
      await pi.emit("tool_call", { toolName: "edit", input }, ctxMock());

      // repair applied in place — the tool never sees the quoted garbage path
      expect(input.path).toBe(outsideFile);
      // edit owns path.advisory, but the repair itself is still recorded
      const events = telemetry.drain();
      expect(events.filter((e) => e.type === "path.advisory")).toHaveLength(0);
      expect(events.filter((e) => e.type === "preflight.normalized")).toHaveLength(1);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("applies the advisory's repair even when the advisory toggle is off", async () => {
    const pi = createPiMock();
    registerPreflight(pi as unknown as ExtensionAPI);
    (getConfig() as any).outsideCwdAdvisoryEnabled = false;
    const outside = mkdtempSync(join("/var/tmp", "preflight-repair-toggled-"));
    const outsideFile = join(outside, "file.txt");
    writeFileSync(outsideFile, "x");

    try {
      const input: Record<string, unknown> = { path: `  "${outsideFile}"  ` };
      await pi.emit("tool_call", { toolName: "read", input }, ctxMock());

      // repair is preflight's core job — independent of advisory visibility
      expect(input.path).toBe(outsideFile);
      const events = telemetry.drain();
      expect(events.filter((e) => e.type === "path.advisory")).toHaveLength(0);
      expect(events.filter((e) => e.type === "preflight.normalized")).toHaveLength(1);
    } finally {
      (getConfig() as any).outsideCwdAdvisoryEnabled = true;
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("allows write tools to create new paths (parent mkdir)", async () => {
    const pi = createPiMock();
    registerPreflight(pi as unknown as ExtensionAPI);
    const target = join(dir, "new-dir", "fresh.txt");

    const result = await pi.emit(
      "tool_call",
      { toolName: "write", input: { path: target } },
      ctxMock(),
    );
    expect(result).toBeUndefined();
    expect(existsSync(dirname(target))).toBe(true); // parent created
  });

  it("passes tools outside PATH_TOOLS through (no phantom patch scope)", async () => {
    const pi = createPiMock();
    registerPreflight(pi as unknown as ExtensionAPI);

    const result = await pi.emit(
      "tool_call",
      {
        toolName: "patch",
        input: { path: "/definitely/not/here-xyz", edits: [] },
      },
      ctxMock(),
    );
    expect(result).toBeUndefined(); // pass — patch is not a PATH_TOOLS entry
  });
});

describe("nearMatches — short-basename noise floor", () => {
  it("does not suggest unrelated files when the query basename is 1-2 chars", () => {
    const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
    const { join } = require("node:path");
    const { tmpdir } = require("node:os");
    const dir = mkdtempSync(join(tmpdir(), "edit-guard-suggest-"));
    // Short ENTRY names are what made the old max(2, ...) floor noisy:
    // every 1-2 char entry sat within distance 2 of any 1-2 char query.
    for (const name of ["x", "y", "w", "a1", "b2", "cd"]) {
      writeFileSync(join(dir, name), "");
    }
    try {
      // 1-char query: old budget 2 suggested x/y/w (distance 1); new
      // budget 0 demands an exact match.
      expect(nearMatches(join(dir, "q"), dir)).toHaveLength(0);
      // 2-char query: old budget 2 suggested cd (distance 2); new budget 1.
      expect(nearMatches(join(dir, "zz"), dir)).toHaveLength(0);
      // Sanity: the exact match still wins when it exists.
      expect(nearMatches(join(dir, "cd"), dir)).toContain("cd");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still suggests plausible neighbors at moderate lengths (3-5 chars)", () => {
    const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
    const { join } = require("node:path");
    const { tmpdir } = require("node:os");
    const dir = mkdtempSync(join(tmpdir(), "edit-guard-suggest2-"));
    writeFileSync(join(dir, "readm.md"), ""); // distance 1 from readme
    writeFileSync(join(dir, "unrelated.docx"), "");
    try {
      const matches = nearMatches(join(dir, "readme.md"), dir);
      expect(matches).toContain("readm.md");
      expect(matches).not.toContain("unrelated.docx");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
