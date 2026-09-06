import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeFile } from "../src/edit/pipeline/execute.js";

describe("partial-apply edge cases", () => {
  let dir: string;

  function write(name: string, content: string): string {
    const file = join(dir, name);
    writeFileSync(file, content);
    return file;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "partial-apply-edge-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("CRLF newText: file keeps inserted CRLF but details.newContent is LF-normalized", async () => {
    const file = write("crlf.txt", "line1\r\nline2\r\nline3\r\n");
    const result = await executeFile(file, [{ oldText: "line2", newText: "LINE2\r\n" }]);
    expect(result.isError).toBe(false);
    const written = readFileSync(file, "utf8");
    expect(written).toContain("LINE2\r\n");
    expect(result.details.newContent).not.toContain("\r\n");
    // Undo would compare restoreLineEndings(newContent, "\r\n") against actual
    expect(written).not.toBe(result.details.newContent);
  });

  it("containment: shorter edit wins when both resolve", async () => {
    const file = write("contain.txt", "hello world");
    const result = await executeFile(file, [
      { oldText: "hello", newText: "hi" },
      { oldText: "hello world", newText: "hi world" },
    ]);
    expect(result.isError).toBe(false);
    expect(result.details.appliedCount).toBe(1);
    expect(result.details.failedCount).toBe(1);
    expect(readFileSync(file, "utf8")).toBe("hi world");
  });

  it("BOM partial apply preserves BOM", async () => {
    const file = write("bom.txt", "\uFEFFline1\nline2\nline3\n");
    const result = await executeFile(file, [
      { oldText: "line1", newText: "LINE1" },
      { oldText: "missing", newText: "MISSING" },
      { oldText: "line3", newText: "LINE3" },
    ]);
    expect(result.isError).toBe(false);
    expect(readFileSync(file, "utf8").startsWith("\uFEFF")).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("\uFEFFLINE1\nline2\nLINE3\n");
  });

  it("write failure during partial apply leaves file unchanged", async () => {
    const file = write("wf.txt", "line1\nline2\nline3\n");
    const result = await executeFile(
      file,
      [
        { oldText: "line1", newText: "LINE1" },
        { oldText: "missing", newText: "MISSING" },
        { oldText: "line3", newText: "LINE3" },
      ],
      {
        rename: () => {
          throw new Error("disk full");
        },
      },
    );
    expect(result.isError).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("line1\nline2\nline3\n");
  });

  it("newText with trailing newline preserves it in the file", async () => {
    const file = write("nl.txt", "line1\nline2\nline3\n");
    const result = await executeFile(file, [{ oldText: "line2", newText: "LINE2\n" }]);
    expect(result.isError).toBe(false);
    const written = readFileSync(file, "utf8");
    expect(written).toContain("LINE2\n");
  });

  it("empty edits array returns validation error instead of crashing", async () => {
    const file = write("empty.txt", "content");
    const result = await executeFile(file, []);
    expect(result.isError).toBe(true);
    expect(result.details.error).toBe("validation");
    expect(result.details.message).toBe("edits array is empty");
  });
});
