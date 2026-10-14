import { describe, it, expect, vi } from "vitest";
import { linkSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeFile } from "../src/edit/pipeline/execute.js";

const POSIX = process.platform !== "win32";

function regularStat(overrides = {}) {
  return {
    mode: 0o100644,
    uid: 1000,
    gid: 1000,
    nlink: 1,
    isFile: () => true,
    ...overrides,
  };
}

const baseOpts = {
  exists: () => true,
  lstat: () => ({ isSymbolicLink: () => false }),
  realpath: (p: string) => p,
  access: () => {},
  chmod: () => {},
  chown: () => {},
};

describe("safe-save filesystem contract", () => {
  it("rejects non-regular files before reading", async () => {
    const readFile = vi.fn(() => Buffer.from("x\n"));
    const result = await executeFile("/tmp/fifo", [{ oldText: "x", newText: "y" }], {
      ...baseOpts,
      readFile,
      stat: () => ({ ...regularStat(), isFile: () => false }),
    });

    expect(result.isError).toBe(true);
    expect(result.details?.error).toBe("non-regular-file");
    expect(readFile).not.toHaveBeenCalled();
  });

  it("writes hardlinked files in place with a non-atomic warning", async () => {
    const files: Record<string, Buffer> = { "/tmp/linked.txt": Buffer.from("hello\n") };
    const rename = vi.fn();
    const written: string[] = [];
    const result = await executeFile("/tmp/linked.txt", [{ oldText: "hello", newText: "bye" }], {
      ...baseOpts,
      readFile: (p) => files[p]!,
      writeFile: (p, data) => {
        written.push(p);
        files[p] = Buffer.from(data as string | Uint8Array);
      },
      rename,
      stat: () => regularStat({ nlink: 2 }),
    });

    expect(result.isError).toBe(false);
    expect(rename).not.toHaveBeenCalled();
    // Direct write to the target, no sibling temp.
    expect(written).toEqual(["/tmp/linked.txt"]);
    expect(String(files["/tmp/linked.txt"])).toContain("bye");
    const warnings = (result.details as { postWriteWarnings?: string[] }).postWriteWarnings ?? [];
    expect(warnings.some((w) => w.includes("[NON-ATOMIC WRITE]") && w.includes("hard link"))).toBe(
      true,
    );
  });

  it("partial apply on a hardlinked file also warns", async () => {
    const files: Record<string, Buffer> = { "/tmp/linked.txt": Buffer.from("hello\nworld\n") };
    const rename = vi.fn();
    const result = await executeFile(
      "/tmp/linked.txt",
      [
        { oldText: "hello", newText: "bye" },
        { oldText: "missing", newText: "MISSING" },
      ],
      {
        ...baseOpts,
        readFile: (p) => files[p]!,
        writeFile: (p, data) => {
          files[p] = Buffer.from(data as string | Uint8Array);
        },
        rename,
        stat: () => regularStat({ nlink: 3 }),
      },
    );

    expect(result.isError).toBe(false);
    expect((result.details as { isPartial?: boolean }).isPartial).toBe(true);
    expect(rename).not.toHaveBeenCalled();
    const warnings = (result.details as { postWriteWarnings?: string[] }).postWriteWarnings ?? [];
    expect(warnings.some((w) => w.includes("[NON-ATOMIC WRITE]"))).toBe(true);
  });

  it("refuses to exploit directory rename permission on read-only files", async () => {
    const files: Record<string, Buffer> = { "/tmp/ro.txt": Buffer.from("hello\n") };
    const writeFile = vi.fn();
    const rename = vi.fn();
    const result = await executeFile("/tmp/ro.txt", [{ oldText: "hello", newText: "bye" }], {
      ...baseOpts,
      readFile: (p) => files[p]!,
      writeFile,
      rename,
      stat: () => regularStat(),
      access: () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
    });

    expect(result.isError).toBe(true);
    expect(result.details?.error).toBe("not-writable");
    expect(String(result.content[0]?.text)).toContain("not writable");
    expect(writeFile).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(String(files["/tmp/ro.txt"])).toBe("hello\n");
  });

  it("reports the matching failure first on a read-only file with a bad edit", async () => {
    const files: Record<string, Buffer> = { "/tmp/ro.txt": Buffer.from("hello\n") };
    const result = await executeFile("/tmp/ro.txt", [{ oldText: "missing", newText: "bye" }], {
      ...baseOpts,
      readFile: (p) => files[p]!,
      writeFile: (p, data) => {
        files[p] = Buffer.from(data as string | Uint8Array);
      },
      rename: (from, to) => {
        files[to] = files[from]!;
      },
      stat: () => regularStat(),
      access: () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
    });

    // Commit-time gate: resolution runs before the writability probe.
    expect(result.isError).toBe(true);
    expect(result.details?.error).not.toBe("not-writable");
  });

  it("ignores ENOENT from the writability probe (injected mock filesystems)", async () => {
    const files: Record<string, Buffer> = { "/tmp/mock.txt": Buffer.from("hello\n") };
    const result = await executeFile("/tmp/mock.txt", [{ oldText: "hello", newText: "bye" }], {
      ...baseOpts,
      readFile: (p) => files[p]!,
      writeFile: (p, data) => {
        files[p] = Buffer.from(data as string | Uint8Array);
      },
      rename: (from, to) => {
        files[to] = files[from]!;
      },
      stat: () => regularStat(),
      access: () => {
        throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
      },
    });

    expect(result.isError).toBe(false);
    expect(String(files["/tmp/mock.txt"])).toContain("bye");
  });

  it("chowns the temp before chmod when owners differ", async () => {
    const files: Record<string, Buffer> = { "/tmp/owned.txt": Buffer.from("hello\n") };
    const chown = vi.fn();
    const chmod = vi.fn();
    const result = await executeFile("/tmp/owned.txt", [{ oldText: "hello", newText: "bye" }], {
      ...baseOpts,
      readFile: (p) => files[p] ?? files["/tmp/owned.txt"]!,
      writeFile: (p, data) => {
        files[p] = Buffer.from(data as string | Uint8Array);
      },
      rename: (from, to) => {
        files[to] = files[from]!;
      },
      stat: (p: string) =>
        p.includes(".edit-guard-")
          ? regularStat({ uid: 0, gid: 0 })
          : regularStat({ uid: 1000, gid: 1000 }),
      chown,
      chmod,
    });

    expect(result.isError).toBe(false);
    expect(chown).toHaveBeenCalledTimes(1);
    expect(chown.mock.calls[0]?.[1]).toBe(1000);
    expect(chown.mock.calls[0]?.[2]).toBe(1000);
    expect(chmod).toHaveBeenCalledTimes(1);
    // chown must precede chmod (chown clears setuid/setgid on Linux).
    expect(chown.mock.invocationCallOrder[0]).toBeLessThan(chmod.mock.invocationCallOrder[0]!);
  });

  it("chown failure warns instead of failing the edit", async () => {
    const files: Record<string, Buffer> = { "/tmp/owned.txt": Buffer.from("hello\n") };
    const result = await executeFile("/tmp/owned.txt", [{ oldText: "hello", newText: "bye" }], {
      ...baseOpts,
      readFile: (p) => files[p] ?? files["/tmp/owned.txt"]!,
      writeFile: (p, data) => {
        files[p] = Buffer.from(data as string | Uint8Array);
      },
      rename: (from, to) => {
        files[to] = files[from]!;
      },
      stat: (p: string) =>
        p.includes(".edit-guard-")
          ? regularStat({ uid: 0, gid: 0 })
          : regularStat({ uid: 1000, gid: 1000 }),
      chown: () => {
        throw new Error("EPERM");
      },
    });

    expect(result.isError).toBe(false);
    expect(String(files["/tmp/owned.txt"])).toContain("bye");
    expect(result.content[0]?.text).toContain("[OWNERSHIP]");
  });

  it("skips chown when owners already match", async () => {
    const files: Record<string, Buffer> = { "/tmp/owned.txt": Buffer.from("hello\n") };
    const chown = vi.fn();
    const result = await executeFile("/tmp/owned.txt", [{ oldText: "hello", newText: "bye" }], {
      ...baseOpts,
      readFile: (p) => files[p] ?? files["/tmp/owned.txt"]!,
      writeFile: (p, data) => {
        files[p] = Buffer.from(data as string | Uint8Array);
      },
      rename: (from, to) => {
        files[to] = files[from]!;
      },
      stat: () => regularStat({ uid: 1000, gid: 1000 }),
      chown,
    });

    expect(result.isError).toBe(false);
    expect(chown).not.toHaveBeenCalled();
  });
});

describe.skipIf(!POSIX)("safe-save hardlink integration", () => {
  it("preserves hard-link identity end to end", async () => {
    const dir = mkdtempSync(join(tmpdir(), "safe-save-hardlink-test-"));
    try {
      const a = join(dir, "a.txt");
      const b = join(dir, "b.txt");
      writeFileSync(a, "hello\n");
      linkSync(a, b);
      expect(statSync(a).nlink).toBe(2);

      const before = statSync(a).ino;
      const result = await executeFile(a, [{ oldText: "hello", newText: "bye" }]);

      expect(result.isError).toBe(false);
      // Same inode: the link relationship survived.
      expect(statSync(a).ino).toBe(before);
      expect(statSync(b).ino).toBe(before);
      expect(readFileSync(b, "utf-8")).toContain("bye");
      const warnings = (result.details as { postWriteWarnings?: string[] }).postWriteWarnings ?? [];
      expect(warnings.some((w) => w.includes("[NON-ATOMIC WRITE]"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
