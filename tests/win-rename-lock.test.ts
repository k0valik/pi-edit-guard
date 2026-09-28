import { describe, it, expect, vi } from "vitest";
import { executeFile } from "../src/edit/pipeline/execute.js";

/**
 * The atomic write commits with a temp file plus rename. On Windows, rename
 * maps to MoveFileEx with MOVEFILE_REPLACE_EXISTING, which needs DELETE access
 * on the destination. A process that holds the destination open without
 * FILE_SHARE_DELETE — a script interpreter that just read the file, an
 * antivirus scan — makes that rename fail with EPERM, EACCES or EBUSY, while
 * a direct write to the same path still succeeds. Before this change the guard reported the edit
 * as failed and deleted the temp file, so a lock of a few hundred milliseconds
 * lost the whole edit.
 */

const ORIGINAL = "line1\nline2\nline3";

/**
 * Fake filesystem keyed by whatever path executeFile resolves the target to, so
 * the test does not depend on how the host platform normalizes paths. The first
 * readFile call is the target read; later reads are the post-write verify.
 */
function makeFs() {
  const files = new Map<string, Buffer>();
  let target = "";
  const readFile = (p: string) => {
    if (!target) target = p;
    if (!files.has(p)) files.set(p, Buffer.from(ORIGINAL, "utf-8"));
    return files.get(p) as Buffer;
  };
  const commit = (from: string, to: string) => {
    files.set(to, files.get(from) ?? Buffer.alloc(0));
  };
  return {
    files,
    target: () => target,
    unlink: vi.fn(),
    opts: {
      readFile,
      writeFile: (p: string, data: Buffer | string) => {
        files.set(p, Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf-8"));
      },
      rename: commit,
      exists: () => true,
      unlink: undefined as never,
      stat: () => ({ mode: 0o644 }),
      lstat: () => ({ isSymbolicLink: () => false }),
      chmod: vi.fn(),
    },
  };
}

function lockError(code: string): Error {
  return Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
}

describe("executeFile rename lock retry", () => {
  it("retries the rename and applies the edit once the lock clears", async () => {
    const fs = makeFs();
    let calls = 0;
    const result = await executeFile("target.txt", [{ oldText: "line1", newText: "LINE1" }], {
      ...fs.opts,
      unlink: fs.unlink,
      rename: (from: string, to: string) => {
        calls += 1;
        if (calls <= 2) throw lockError("EPERM");
        fs.opts.rename?.(from, to);
      },
    });

    expect(result.isError).toBe(false);
    expect(calls).toBe(3);
    expect(String(fs.files.get(fs.target()))).toBe("LINE1\nline2\nline3");
    expect(result.details?.postWriteWarnings).toEqual([]);
  });

  it("writes directly to the destination when the lock never clears", async () => {
    const fs = makeFs();
    const rename = vi.fn(() => {
      throw lockError("EPERM");
    });
    const result = await executeFile("target.txt", [{ oldText: "line2", newText: "LINE2" }], {
      ...fs.opts,
      unlink: fs.unlink,
      rename,
    });

    expect(result.isError).toBe(false);
    expect(rename).toHaveBeenCalledTimes(5); // first attempt + 4 backoff retries
    expect(String(fs.files.get(fs.target()))).toBe("line1\nLINE2\nline3");
    const warnings = (result.details?.postWriteWarnings ?? []) as string[];
    expect(warnings.some((w) => w.includes("[NON-ATOMIC WRITE]"))).toBe(true);
    expect(fs.unlink).toHaveBeenCalledTimes(1);
  });

  it("retries EACCES and EBUSY lock errors, not just EPERM", async () => {
    const fs = makeFs();
    const codes = ["EACCES", "EBUSY"];
    let calls = 0;
    const result = await executeFile("target.txt", [{ oldText: "line3", newText: "LINE3" }], {
      ...fs.opts,
      unlink: fs.unlink,
      rename: (from: string, to: string) => {
        calls += 1;
        if (calls <= codes.length) throw lockError(codes[calls - 1] as string);
        fs.opts.rename?.(from, to);
      },
    });

    expect(result.isError).toBe(false);
    expect(calls).toBe(3);
    expect(String(fs.files.get(fs.target()))).toBe("line1\nline2\nLINE3");
    expect(result.details?.postWriteWarnings).toEqual([]);
  });

  it("surfaces the original rename error when the direct-write fallback also fails", async () => {
    const fs = makeFs();
    const rename = vi.fn(() => {
      throw lockError("EPERM");
    });
    const result = await executeFile("target.txt", [{ oldText: "line1", newText: "LINE1" }], {
      ...fs.opts,
      unlink: fs.unlink,
      rename,
      // Tmp writes succeed; only the direct write to the destination fails,
      // so the fallback cannot save the edit. Target is captured on the
      // first readFile call, before any write, so the comparison is valid.
      writeFile: (p: string, data: Buffer | string) => {
        if (p === fs.target()) throw new Error("EACCES: permission denied, open");
        fs.opts.writeFile(p, data);
      },
    });

    expect(result.isError).toBe(true);
    expect(rename).toHaveBeenCalledTimes(5); // first attempt + 4 backoff retries
    expect(result.details?.error).toBe("write-failed");
    expect(String(result.details?.message)).toContain("EPERM");
    expect(String(fs.files.get(fs.target()))).toBe(ORIGINAL);
    expect(fs.unlink).toHaveBeenCalled();
  });

  it("does not retry a rename error that cannot clear by waiting", async () => {
    const fs = makeFs();
    const rename = vi.fn(() => {
      throw lockError("EISDIR");
    });
    const result = await executeFile("target.txt", [{ oldText: "line1", newText: "LINE1" }], {
      ...fs.opts,
      unlink: fs.unlink,
      rename,
    });

    expect(result.isError).toBe(true);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(String(fs.files.get(fs.target()))).toBe(ORIGINAL);
  });
});
