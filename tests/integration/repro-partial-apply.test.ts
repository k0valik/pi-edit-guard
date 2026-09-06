import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { executeFile } from "../../src/edit/pipeline/execute.js";

class InMemoryFS {
  private files = new Map<string, Buffer>();

  writeFile(path: string, content: string | Buffer) {
    this.files.set(path, typeof content === "string" ? Buffer.from(content, "utf-8") : content);
  }

  readFile(path: string): Buffer {
    const buf = this.files.get(path);
    if (!buf) throw new Error("ENOENT: " + path);
    return buf;
  }

  exists(path: string): boolean {
    return this.files.has(path);
  }

  rename(from: string, to: string) {
    const buf = this.files.get(from);
    if (!buf) throw new Error("ENOENT: " + from);
    this.files.set(to, buf);
    this.files.delete(from);
  }

  mkdir(_path: string) {}
  unlink(path: string) {
    this.files.delete(path);
  }
}

describe("repro: partial-apply corruption detection", () => {
  it("detects cascading duplicates after partial apply (red phase)", async () => {
    // Simple fixture: two tokens side by side.
    const fileContent = "AAA\nBBB\n";

    // Both edits insert the same long text. Edit 2 targets a non-existent string
    // to force the partial-apply path while still having both edits succeed.
    // Block must be >= 120 chars to pass the short-replacement guard.
    const duplicatedBlock = "class Foo {\n  method() {}\n}\nclass Foo {\n  dup() {}\n}\n".repeat(3);
    const edits = [
      { oldText: "AAA", newText: duplicatedBlock },
      { oldText: "BBB", newText: duplicatedBlock },
      { oldText: "ZZZ", newText: "WILL_FAIL" },
    ];

    const runId = randomUUID().slice(0, 8);
    const tempDir = join(tmpdir(), "repro-partial-apply-" + runId);
    mkdirSync(tempDir, { recursive: true });
    const absolutePath = join(tempDir, "repro-partial-apply.txt");
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, fileContent, "utf-8");

    const fs = new InMemoryFS();
    fs.writeFile(absolutePath, fileContent);

    const result = await executeFile(absolutePath, edits, {
      readFile: (p) => fs.readFile(p),
      writeFile: (p, c) => fs.writeFile(p, c),
      rename: (from, to) => fs.rename(from, to),
      exists: (p) => fs.exists(p),
      mkdir: (p) => fs.mkdir(p),
      unlink: (p) => fs.unlink(p),
    });

    // Partial apply should have succeeded (not an error).
    expect(result.isError).toBe(false);

    // The file content should contain the cascading duplicate.
    const written = fs.readFile(absolutePath).toString("utf-8");
    expect(written).toBe(duplicatedBlock + "\n" + duplicatedBlock + "\n");

    // After the fix (post-edit content), this should detect the duplicate.
    expect((result.details.corruptionWarnings as string[]).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// SYNTHETIC generalization (mined 2026-08-17 session, docs/architecture.md):
// a 9-edit call reported "Applied 8 of 9" with edits[2]: missing while the
// file visibly contained edits[2]'s replacement. Root causes were structural:
//   1. execute.ts's partial merge re-derived resolve-failure indices by
//      regex-matching error MESSAGE TEXT for `edits[N]` — any message quoting
//      foreign indices desynced the overlay.
//   2. apply-stage failure diagnostics re-derived indices via findIndex on
//      the edit triple — identical twins pinned failures to the first twin.
//   3. invariant apply-failures displayed as "missing" instead of validation.
// Wild reconstruction was impossible (fuzzy edit history broke snapshot
// replay), so the mechanism is proven here with labeled synthetic content.
// ---------------------------------------------------------------------------
describe("repro: partial-apply diagnostic desync (structural indices)", () => {
  it("keeps applied/failed attribution correct with duplicate twins and quoting content", async () => {
    const fs = new InMemoryFS();
    const file = "/repo/desync.txt";
    fs.writeFile(
      file,
      ["alpha section", "beta section mentions edits[9] inside its text", "gamma section"].join(
        "\n",
      ),
    );

    const result = await executeFile(
      file,
      [
        // Twin pair: identical triple. First applies, second must report as
        // already-handled against ITS index (1), never misattributed to 0.
        { oldText: "gamma section", newText: "gamma rewritten" },
        { oldText: "gamma section", newText: "gamma rewritten" },
        // Resolves and applies; its text quotes a FOREIGN edits[9] index —
        // the old message-regex extraction choked on exactly this shape.
        {
          oldText: "beta section mentions edits[9] inside its text",
          newText: "beta section now references edits[7] in its text",
        },
        // Genuinely missing.
        { oldText: "delta section", newText: "delta rewritten" },
      ],
      {
        cwd: "/repo",
        readFile: (p) => fs.readFile(p),
        writeFile: (p, c) => fs.writeFile(p, c),
        rename: (from, to) => fs.rename(from, to),
        exists: (p) => fs.exists(p),
        mkdir: () => {},
        unlink: (p) => fs.unlink(p),
      },
    );

    expect(result.isError).toBe(false);
    const details = result.details as any;
    expect(details.isPartial).toBe(true);
    const diags = details.diagnostics as Array<{ index: number; status: string }>;
    const byIndex = new Map(diags.map((d) => [d.index, d.status]));
    expect(byIndex.get(0)).toBe("applied");
    expect(byIndex.get(1)).toBe("overlap");
    expect(byIndex.get(2)).toBe("applied");
    expect(byIndex.get(3)).toBe("missing");
    const text = result.content.map((c) => c.text || "").join("\n");
    expect(text).toContain("edits[3]: missing");
    expect(text).toContain("edits[1]: overlap");
    expect(text).not.toContain("edits[0]:");
  });
});

describe("details.editsApplied carries applied INDICES (not a count)", () => {
  // The partial-apply message prints "Applied edit indices: ..." by joining this
  // field — as a bare number the join silently produced nothing and the
  // feature was dead since the partial-apply path landed.
  it("lists which block indices applied on a partial apply", async () => {
    const fs = new InMemoryFS();
    const file = "/repo/idx.txt";
    fs.writeFile(file, "one\ntwo\nthree\nfour");
    const result = await executeFile(
      file,
      [
        { oldText: "one", newText: "ONE" },
        { oldText: "nope", newText: "NOPE" },
        { oldText: "three", newText: "THREE" },
        { oldText: "four", newText: "FOUR" },
      ],
      {
        cwd: "/repo",
        readFile: (p) => fs.readFile(p),
        writeFile: (p, c) => fs.writeFile(p, c),
        rename: (from, to) => fs.rename(from, to),
        exists: (p) => fs.exists(p),
        mkdir: () => {},
        unlink: () => {},
      },
    );
    expect(result.isError).toBe(false);
    expect((result.details as { editsApplied: number[] }).editsApplied).toEqual([0, 2, 3]);
  });

  it("lists every index on a full apply", async () => {
    const fs = new InMemoryFS();
    const file = "/repo/full.txt";
    fs.writeFile(file, "alpha\nbeta");
    const result = await executeFile(
      file,
      [
        { oldText: "alpha", newText: "ALPHA" },
        { oldText: "beta", newText: "BETA" },
      ],
      {
        cwd: "/repo",
        readFile: (p) => fs.readFile(p),
        writeFile: (p, c) => fs.writeFile(p, c),
        rename: (from, to) => fs.rename(from, to),
        exists: (p) => fs.exists(p),
        mkdir: () => {},
        unlink: () => {},
      },
    );
    expect(result.isError).toBe(false);
    expect((result.details as { editsApplied: number[] }).editsApplied).toEqual([0, 1]);
  });
});
