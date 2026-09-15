// Regression tests: editing a file must preserve its permission mode.
//
// Atomic tmp-file + rename replaces the original inode, so the tmp file
// would otherwise inherit umask-derived permissions and the edited file
// would lose its executable bit (mined 2026-09-15: 755 -> 664, script no
// longer directly executable, git mode 100755 -> 100644). The write paths
// restore the pre-read mode onto the tmp file before rename.
//
// Platform scope: on POSIX the full mode (incl. exec/setuid/sticky, masked
// 0o7777) is preserved. On Windows Node synthesizes only the read-only flag
// (0o444 vs 0o666) and chmod can only toggle that flag — so the same code
// preserves everything Windows supports and is a harmless no-op otherwise.
// Tests therefore assert before==after everywhere and gate exact-bit
// assertions on POSIX.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, readFileSync, rmSync, mkdtempSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeFile } from "../src/edit/pipeline/execute.js";

const POSIX = process.platform !== "win32";

function modeOf(p: string): number {
  return statSync(p).mode & 0o7777;
}

describe("file mode preservation", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mode-preservation-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeScript(name: string, mode: number): string {
    const file = join(dir, name);
    writeFileSync(file, "#!/usr/bin/env bash\nprintf 'before\\n'\n");
    chmodSync(file, mode);
    return file;
  }

  const EDIT = { oldText: "printf 'before\\n'", newText: "printf 'after\\n'" };

  it("full apply preserves the executable bit", async () => {
    const file = writeScript("run.sh", 0o755);
    const before = modeOf(file);
    if (POSIX) expect(before).toBe(0o755);

    const result = await executeFile(file, [EDIT]);

    expect(result.isError).toBe(false);
    expect(readFileSync(file, "utf-8")).toContain("printf 'after\\n'");
    expect(modeOf(file)).toBe(before);
    if (POSIX) expect(modeOf(file) & 0o111).toBe(0o111);
  });

  it("full apply preserves a non-executable mode", async () => {
    const file = writeScript("plain.sh", 0o644);
    const before = modeOf(file);

    const result = await executeFile(file, [EDIT]);

    expect(result.isError).toBe(false);
    expect(modeOf(file)).toBe(before);
  });

  it("partial apply preserves the executable bit", async () => {
    const file = writeScript("run.sh", 0o755);
    const before = modeOf(file);

    const result = await executeFile(file, [EDIT, { oldText: "missing", newText: "MISSING" }]);

    expect(result.isError).toBe(false);
    expect((result.details as { isPartial?: boolean }).isPartial).toBe(true);
    expect(readFileSync(file, "utf-8")).toContain("printf 'after\\n'");
    expect(modeOf(file)).toBe(before);
    if (POSIX) expect(modeOf(file) & 0o111).toBe(0o111);
  });

  it("partial apply preserves a non-executable mode", async () => {
    const file = writeScript("plain.sh", 0o644);
    const before = modeOf(file);

    const result = await executeFile(file, [EDIT, { oldText: "missing", newText: "MISSING" }]);

    expect(result.isError).toBe(false);
    expect((result.details as { isPartial?: boolean }).isPartial).toBe(true);
    expect(modeOf(file)).toBe(before);
  });

  it("chmod failure warns instead of failing the edit", async () => {
    const files: Record<string, Buffer> = { "/tmp/mode-warn.txt": Buffer.from("hello\n") };
    const result = await executeFile("/tmp/mode-warn.txt", [{ oldText: "hello", newText: "bye" }], {
      readFile: (p) => files[p]!,
      writeFile: (p, data) => {
        files[p] = Buffer.from(data as string | Uint8Array);
      },
      rename: (from, to) => {
        files[to] = files[from]!;
      },
      exists: () => true,
      stat: () => ({ mode: 0o100755 }),
      chmod: () => {
        throw new Error("EPERM");
      },
    });

    expect(result.isError).toBe(false);
    expect(String(files["/tmp/mode-warn.txt"])).toContain("bye");
    expect(result.content[0]?.text).toContain("[MODE PRESERVATION]");
  });
});
