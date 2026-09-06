/**
 * Overwrite guard tests.
 *
 * Validates the core OverwriteGuard logic and the hook registration. Tests
 * follow the patterns from `write-guard.test.ts` and `stale-read-hook.test.ts`.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPiMock } from "../packages/pi-base/src/pi-mock.js";
import { OverwriteGuard } from "../src/guards/overwrite/guard.js";
import { registerOverwriteGuard } from "../src/platform/hooks/overwrite.js";
import { getConfig } from "../src/config/settings.js";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "overwrite-guard-test-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("OverwriteGuard core", () => {
  it("allows new file creation", () => {
    const guard = new OverwriteGuard();
    const file = join(dir, "new-file.txt");

    expect(guard.checkWrite(file)).toBeNull();
  });

  it("allows overwriting an empty file", () => {
    const file = join(dir, "empty.txt");
    writeFileSync(file, "");

    const guard = new OverwriteGuard();
    expect(guard.checkWrite(file)).toBeNull();
  });

  it("blocks the first write to an existing file and nudges", () => {
    const file = join(dir, "existing.txt");
    writeFileSync(file, "line1\nline2\nline3\n");

    const guard = new OverwriteGuard();
    const reason = guard.checkWrite(file);

    expect(reason).not.toBeNull();
    expect(reason).toContain("🚫 Overwrite blocked — file exists and has content.");
    expect(reason).toContain("already exists (4 lines)");
    expect(reason).toContain("Use `edit` for targeted changes");
  });

  it("allows the second write to the same file (nudged)", () => {
    const file = join(dir, "nudge.txt");
    writeFileSync(file, "line1\n");

    const guard = new OverwriteGuard();
    expect(guard.checkWrite(file)).not.toBeNull(); // first write blocked
    expect(guard.checkWrite(file)).toBeNull(); // second write allowed
  });

  it("tracks different files independently", () => {
    const fileA = join(dir, "a.txt");
    const fileB = join(dir, "b.txt");
    writeFileSync(fileA, "content a\n");
    writeFileSync(fileB, "content b\n");

    const guard = new OverwriteGuard();
    expect(guard.checkWrite(fileA)).not.toBeNull();
    expect(guard.checkWrite(fileA)).toBeNull(); // allowed for A
    expect(guard.checkWrite(fileB)).not.toBeNull(); // B is still blocked
  });

  it("reset clears nudged state", () => {
    const file = join(dir, "reset.txt");
    writeFileSync(file, "content\n");

    const guard = new OverwriteGuard();
    expect(guard.checkWrite(file)).not.toBeNull();
    guard.reset();
    expect(guard.checkWrite(file)).not.toBeNull(); // blocked again after reset
  });
});

describe("overwrite guard hook", () => {
  function withOverwriteGuardEnabled(enabled: boolean, fn: () => void) {
    const cfg = getConfig();
    const prev = (cfg as { overwriteGuardEnabled?: boolean }).overwriteGuardEnabled;
    (cfg as { overwriteGuardEnabled: boolean }).overwriteGuardEnabled = enabled;
    try {
      fn();
    } finally {
      (cfg as { overwriteGuardEnabled?: boolean }).overwriteGuardEnabled = prev;
    }
  }

  it("blocks a write to an existing file via tool_call", async () => {
    withOverwriteGuardEnabled(true, async () => {
      const pi = createPiMock();
      registerOverwriteGuard(pi as unknown as ExtensionAPI);
      const file = join(dir, "hook-block.txt");
      writeFileSync(file, "line1\nline2\n");

      const result = await pi.emit("tool_call", {
        toolName: "write",
        input: { path: file, content: "new content" },
      });

      expect(result).toEqual(
        expect.objectContaining({
          block: true,
          reason: expect.stringContaining("🚫 Overwrite blocked"),
        }),
      );
    });
  });

  it("allows a write to a new file via tool_call", async () => {
    withOverwriteGuardEnabled(true, async () => {
      const pi = createPiMock();
      registerOverwriteGuard(pi as unknown as ExtensionAPI);
      const file = join(dir, "hook-new.txt");

      const result = await pi.emit("tool_call", {
        toolName: "write",
        input: { path: file, content: "hello" },
      });

      expect(result).toBeUndefined();
    });
  });

  it("allows a second write to the same file in the same session", async () => {
    withOverwriteGuardEnabled(true, async () => {
      const pi = createPiMock();
      registerOverwriteGuard(pi as unknown as ExtensionAPI);
      const file = join(dir, "hook-retry.txt");
      writeFileSync(file, "line1\n");

      const first = await pi.emit("tool_call", {
        toolName: "write",
        input: { path: file, content: "new" },
      });
      expect(first).toEqual(expect.objectContaining({ block: true }));

      const second = await pi.emit("tool_call", {
        toolName: "write",
        input: { path: file, content: "new" },
      });
      expect(second).toBeUndefined();
    });
  });

  it("skips non-write tools", async () => {
    withOverwriteGuardEnabled(true, async () => {
      const pi = createPiMock();
      registerOverwriteGuard(pi as unknown as ExtensionAPI);
      const file = join(dir, "hook-skip.txt");
      writeFileSync(file, "content\n");

      const result = await pi.emit("tool_call", {
        toolName: "edit",
        input: { path: file, edits: [{ oldText: "content", newText: "new" }] },
      });

      expect(result).toBeUndefined();
    });
  });

  it("skips tools with no path", async () => {
    withOverwriteGuardEnabled(true, async () => {
      const pi = createPiMock();
      registerOverwriteGuard(pi as unknown as ExtensionAPI);
      const file = join(dir, "hook-no-path.txt");
      writeFileSync(file, "content\n");

      const result = await pi.emit("tool_call", {
        toolName: "write",
        input: { content: "hello" },
      });

      expect(result).toBeUndefined();
    });
  });

  it("clears state on session_shutdown", async () => {
    withOverwriteGuardEnabled(true, async () => {
      const pi = createPiMock();
      const { guard } = registerOverwriteGuard(pi as unknown as ExtensionAPI);
      const file = join(dir, "hook-shutdown.txt");
      writeFileSync(file, "content\n");

      await pi.emit("tool_call", {
        toolName: "write",
        input: { path: file, content: "new" },
      });
      expect(guard.checkWrite(file)).toBeNull(); // nudged

      await pi.emit("session_shutdown", {});
      expect(guard.checkWrite(file)).not.toBeNull(); // blocked again
    });
  });

  it("allows all writes when overwriteGuardEnabled is false", async () => {
    const pi = createPiMock();
    registerOverwriteGuard(pi as unknown as ExtensionAPI);
    const file = join(dir, "hook-disabled.txt");
    writeFileSync(file, "content\n");

    const prev = (getConfig() as { overwriteGuardEnabled?: boolean }).overwriteGuardEnabled;
    try {
      (getConfig() as { overwriteGuardEnabled: boolean }).overwriteGuardEnabled = false;

      const result = await pi.emit("tool_call", {
        toolName: "write",
        input: { path: file, content: "new" },
      });

      expect(result).toBeUndefined();
    } finally {
      (getConfig() as { overwriteGuardEnabled?: boolean }).overwriteGuardEnabled = prev;
    }
  });
});
