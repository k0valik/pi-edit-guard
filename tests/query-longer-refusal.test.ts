/**
 * Query-longer-than-match refusal — a fuzzy pass that returns a window with
 * fewer content lines than the query hallucinated structure the file never
 * had (benchmark duplicate-import: 4-line oldText against a 3-line file
 * duplicated the line instead of replacing it).
 *
 * Blank-line variance stays legal: only non-blank line counts are compared,
 * so dropped/added blank framing still resolves.
 */
import { describe, it, expect } from "vitest";
import { executeFile } from "../src/edit/pipeline/execute.js";

async function runOnce(
  content: string,
  oldText: string,
  newText: string,
): Promise<{ isError: boolean; written: string }> {
  const path = "/bench/t.txt";
  const store = new Map<string, Buffer>([[path, Buffer.from(content, "utf-8")]]);
  const result = await executeFile(path, [{ oldText, newText }], {
    cwd: "/bench",
    readFile: (p) => {
      const hit = store.get(p);
      if (hit === undefined) throw new Error(`unexpected read: ${p}`);
      return hit;
    },
    writeFile: (p, data) => {
      store.set(p, Buffer.isBuffer(data) ? data : Buffer.from(data, "utf-8"));
    },
    rename: (from, to) => {
      store.set(to, store.get(from)!);
      store.delete(from);
    },
    exists: () => true,
    mkdir: () => {},
    unlink: (p) => {
      store.delete(p);
    },
    stat: () => ({ mode: 0o644 }),
    chmod: () => {},
    lstat: () => ({ isSymbolicLink: () => false }),
    realpath: (p) => p,
  });
  return { isError: result.isError, written: store.get(path)!.toString("utf-8") };
}

describe("query-longer-than-match refusal", () => {
  it("refuses a hallucinated 4-line query against a 3-line file", async () => {
    const file = "import { a } from 'x';\nimport { b } from 'y';\nimport { a } from 'x';\n";
    const { isError, written } = await runOnce(
      file,
      "import { a } from 'x';\nimport { b } from 'y';\nimport { a } from 'x';\nimport { a } from 'x';",
      "import { a } from 'x';\nimport { b } from 'y';\nimport { a2 } from 'x';\nimport { a } from 'x';",
    );
    expect(isError).toBe(true);
    expect(written).toBe(file);
  });

  it("still applies when the query adds blank framing lines", async () => {
    const { isError, written } = await runOnce("aaa\nbbb\nccc\n", "\nbbb\n\n", "BBB");
    expect(isError).toBe(false);
    expect(written).toBe("aaa\nBBB\nccc\n");
  });

  it("still applies when the query drops a blank line", async () => {
    const { isError, written } = await runOnce("aaa\n\nbbb\n", "aaa\nbbb", "AAA\nBBB");
    expect(isError).toBe(false);
    expect(written).toBe("AAA\nBBB\n");
  });

  it("still applies a verbatim multi-line replace", async () => {
    const { isError, written } = await runOnce("aaa\nbbb\nccc\nddd\n", "bbb\nccc", "B\nC");
    expect(isError).toBe(false);
    expect(written).toBe("aaa\nB\nC\nddd\n");
  });

  it("allows a surplus line the file never had (novel content, not repetition)", async () => {
    // Insert-via-replace: the extra line is novel, so the fuzzy chain owns it.
    const { isError, written } = await runOnce(
      "aaa\nbbb\nccc\n",
      "bbb\nccc\nEXTRA",
      "bbb\nccc\nEXTRA!",
    );
    expect(isError).toBe(false);
    expect(written).toBe("aaa\nbbb\nccc\nEXTRA!");
  });
});
