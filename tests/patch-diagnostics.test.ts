import { describe, it, expect } from "vitest";
import { executeFile } from "../src/edit/pipeline/execute.js";

describe("executeFile diagnostics", () => {
  const writeFileSync = (_path: string, _data: Buffer | string) => {
    // no-op for tests; we use readFileSync override instead
  };

  it("returns per-edit diagnostics when one edit in a batch is not-found", async () => {
    const content = "line1\nline2\nline3\nline4\nline5";
    const edits = [
      { oldText: "line2", newText: "LINE2" },
      { oldText: "not-in-file", newText: "MISSING" },
    ];

    const result = await executeFile("test.txt", edits, {
      readFile: () => Buffer.from(content),
      writeFile: writeFileSync,
      rename: () => {},
      exists: () => true,
      mkdir: () => {},
    });

    expect(result.isError).toBe(false);
    expect(result.details.isPartial).toBe(true);
    expect(result.details).toBeDefined();
    expect((result.details as any)?.diagnostics).toBeDefined();
    const diags = (result.details as any).diagnostics as Array<{
      index: number;
      status: string;
      oldText: string;
    }>;
    expect(diags).toHaveLength(2);
    expect(diags[0]).toMatchObject({
      index: 0,
      status: "applied",
      oldText: "line2",
    });
    expect(diags[1]).toMatchObject({
      index: 1,
      status: "missing",
      oldText: "not-in-file",
    });
  });

  it("returns alternative candidates for ambiguous matches", async () => {
    const content = "x\nfoo\ny\nx\nfoo\nz";
    const edits = [{ oldText: "foo", newText: "FOO" }];

    const result = await executeFile("test.txt", edits, {
      readFile: () => Buffer.from(content),
      writeFile: writeFileSync,
      rename: () => {},
      exists: () => true,
      mkdir: () => {},
    });

    expect(result.isError).toBe(true);
    expect((result.details as any)?.diagnostics).toBeDefined();
    const diags = (result.details as any).diagnostics as Array<{
      index: number;
      status: string;
      alternatives?: Array<{
        startLine: number;
        endLine: number;
        similarity: number;
      }>;
    }>;
    expect(diags[0].status).toBe("ambiguous");
    expect(diags[0].alternatives).toBeDefined();
    expect(diags[0].alternatives!.length).toBeGreaterThan(1);
    expect(diags[0].alternatives![0]).toMatchObject({
      startLine: expect.any(Number),
      endLine: expect.any(Number),
      similarity: expect.any(Number),
    });
  });

  it("returns near-miss candidates for not-found edits", async () => {
    const content = "function hello() {\n  return 42;\n}\nfunction hello() {\n  return 43;\n}\n";
    const edits = [{ oldText: "function goodbye() {\n  return 44;\n}\n", newText: "X" }];

    const result = await executeFile("test.txt", edits, {
      readFile: () => Buffer.from(content),
      writeFile: writeFileSync,
      rename: () => {},
      exists: () => true,
      mkdir: () => {},
    });

    expect(result.isError).toBe(true);
    const diags = (result.details as any).diagnostics as Array<{
      index: number;
      status: string;
      alternatives?: Array<{ similarity: number }>;
    }>;
    expect(diags[0].status).toBe("missing");
    expect(diags[0].alternatives).toBeDefined();
    expect(diags[0].alternatives!.length).toBeGreaterThan(0);
    expect(diags[0].alternatives![0].similarity).toBeGreaterThan(0);
  });

  it("returns overlap diagnostics for overlapping edits", async () => {
    const content = "hello world foo";
    const edits = [
      { oldText: "hello world", newText: "hi world" },
      { oldText: "world foo", newText: "earth bar" },
    ];

    const result = await executeFile("test.txt", edits, {
      readFile: () => Buffer.from(content),
      writeFile: writeFileSync,
      rename: () => {},
      exists: () => true,
      mkdir: () => {},
    });

    expect(result.isError).toBe(false);
    expect(result.details.isPartial).toBe(true);
    const diags = (result.details as any).diagnostics as Array<{
      index: number;
      status: string;
    }>;
    expect(diags.some((d: any) => d.status === "overlap")).toBe(true);
  });

  it("includes preview snippets in diagnostics", async () => {
    const content = "function hello() {\n  return 42;\n}\nfunction hello() {\n  return 43;\n}\n";
    const edits = [{ oldText: "function goodbye() {\n  return 44;\n}\n", newText: "X" }];

    const result = await executeFile("test.txt", edits, {
      readFile: () => Buffer.from(content),
      writeFile: writeFileSync,
      rename: () => {},
      exists: () => true,
      mkdir: () => {},
    });

    expect(result.isError).toBe(true);
    const diags = (result.details as any).diagnostics as Array<{
      index: number;
      alternatives?: Array<{
        preview?: { before: unknown[]; matched: unknown[]; after: unknown[] };
      }>;
    }>;
    const withPreview = diags.find((d: any) => d.alternatives && d.alternatives[0]?.preview);
    expect(withPreview).toBeDefined();
    expect(withPreview!.alternatives![0].preview).toBeDefined();
    expect(withPreview!.alternatives![0].preview!.before).toBeDefined();
    expect(withPreview!.alternatives![0].preview!.matched).toBeDefined();
    expect(withPreview!.alternatives![0].preview!.after).toBeDefined();
  });
});
