import { describe, it, expect } from "vitest";
import { executeFile } from "../src/edit/pipeline/execute.js";

// Confusable-glyph advisories (mined 2026-09-09: U+EE9C PUA was silently
// replaced by lookalike U+2E9C). All glyphs below are \u escapes — never
// literals (see the hygiene note on CONFUSABLE_CLASSES in execute.ts).
// Nothing here comes from any real repo file; the shapes are synthetic.
const EE = "\uEE9C"; // U+EE9C private-use (file-side glyph)
const RADICAL = "\u2E9C"; // U+2E9C CJK radical (model-typed lookalike)

function memfs(initial: Record<string, string>) {
  const files: Record<string, Buffer> = Object.fromEntries(
    Object.entries(initial).map(([k, v]) => [k, Buffer.from(v, "utf-8")]),
  );
  return {
    files,
    readFile: (p: string) => {
      const b = files[p];
      if (!b) throw new Error(`not found: ${p}`);
      return b;
    },
    writeFile: (p: string, data: Buffer | string) => {
      files[p] = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf-8");
    },
    rename: (from: string, to: string) => {
      files[to] = files[from] ?? Buffer.alloc(0);
    },
    exists: () => true,
  };
}

describe("confusable-glyph warnings", () => {
  it("warns when oldText bridges a lookalike gap (search-side)", async () => {
    const fs = memfs({ "/t.txt": `icon line ${EE} high\nsecond line\nthird line\n` });
    const result = await executeFile(
      "/t.txt",
      [{ oldText: `icon line ${RADICAL} high\nsecond line\nthird line`, newText: "replaced\n" }],
      fs,
    );
    expect(result.isError).toBe(false);
    const warnings = (result.details as { confusableWarnings?: string[] }).confusableWarnings;
    expect(warnings?.length).toBe(1);
    expect(warnings?.[0]).toContain("U+2E9C");
    expect(warnings?.[0]).toContain("U+EE9C");
    expect(result.content[0]?.text).toContain("CONFUSABLE GLYPH");
  });

  it("warns when newText inserts a lookalike the file does not use (insert-side)", async () => {
    const fs = memfs({ "/t.txt": `anchor one\nanchor two\nelsewhere ${EE} icon\n` });
    const result = await executeFile(
      "/t.txt",
      [
        {
          oldText: "anchor one\nanchor two",
          newText: `anchor one\nnew ${RADICAL} glyph\nanchor two`,
        },
      ],
      fs,
    );
    expect(result.isError).toBe(false);
    const written = String(fs.files["/t.txt"]);
    expect(written).toContain(RADICAL);
    const warnings = (result.details as { confusableWarnings?: string[] }).confusableWarnings;
    expect(warnings?.length).toBe(1);
    expect(warnings?.[0]).toContain("U+2E9C");
    expect(warnings?.[0]).toContain("U+EE9C");
  });

  it("stays silent for clean edits and consistent glyph use", async () => {
    const fs = memfs({ "/t.txt": `icon ${EE} here\nsecond line\n` });
    const result = await executeFile(
      "/t.txt",
      [{ oldText: "second line", newText: `second ${EE} line` }],
      fs,
    );
    expect(result.isError).toBe(false);
    expect((result.details as { confusableWarnings?: string[] }).confusableWarnings).toEqual([]);
    expect(result.content[0]?.text).not.toContain("CONFUSABLE GLYPH");
  });
});
