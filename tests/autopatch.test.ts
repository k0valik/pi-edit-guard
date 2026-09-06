import { describe, expect, it } from "vitest";
import {
  computeTrailingWhitespaceOldTextPatch,
  stripTrailingWhitespaceDetailed,
} from "../src/edit/patching/autopatch/trailing-ws.js";
import { autopatchBlocks } from "../src/edit/patching/autopatch/index.js";
import { executeFile } from "../src/edit/pipeline/execute.js";
import type { ParsedBlock } from "../src/edit/model.js";

// ─── Pass 1: trailing whitespace ─────────────────────────────────────────

describe("autopatch trailing whitespace (Pass 1)", () => {
  it("does not patch when the original raw oldText already matches", () => {
    const patch = computeTrailingWhitespaceOldTextPatch({
      oldText: "foo\n\n",
      newText: "baz\n\n",
      fileContent: "foo\n\nbar\n",
    });
    expect(patch).toBeUndefined();
  });

  it("requires the stripped raw candidate to match exactly once", () => {
    const patch = computeTrailingWhitespaceOldTextPatch({
      oldText: "foo   ",
      newText: "bar",
      fileContent: "foo\nfoo\n",
    });
    expect(patch).toBeUndefined();
  });

  it("distinguishes line trailing whitespace from trailing empty lines", () => {
    const stripped = stripTrailingWhitespaceDetailed("foo   \nbar\n\t\t");
    expect(stripped).toEqual({
      text: "foo\nbar",
      removedLineTrailingWhitespace: true,
      removedTrailingEmptyLineCount: 1,
    });
  });

  it("patches trailing spaces when original misses and stripped form is unique", () => {
    const patch = computeTrailingWhitespaceOldTextPatch({
      oldText: "foo   ",
      newText: "bar   ",
      fileContent: "foo\n",
    });
    expect(patch).toMatchObject({
      oldText: "foo",
      newText: "bar   ",
      removedLineTrailingWhitespace: true,
      removedTrailingEmptyLineCount: 0,
    });
  });

  it("strips an equivalent trailing empty-line suffix from newText", () => {
    const patch = computeTrailingWhitespaceOldTextPatch({
      oldText: "foo\n\n",
      newText: "baz\n\n",
      fileContent: "foo\nbar\n",
    });
    expect(patch).toMatchObject({
      oldText: "foo",
      newText: "baz",
      removedTrailingEmptyLineCount: 2,
    });
  });

  it("normalizes CRLF before exact raw matching", () => {
    const patch = computeTrailingWhitespaceOldTextPatch({
      oldText: "foo\r\n\t",
      newText: "bar\r\n\t",
      fileContent: "foo\r\nnext\r\n",
    });
    expect(patch?.oldText).toBe("foo");
    expect(patch?.newText).toBe("bar");
  });
});

// ─── Pass 0: escaped control characters ──────────────────────────────────

describe("autopatch escaped control characters (Pass 0)", () => {
  it("corrects when original misses and escaped variant is unique", () => {
    const blocks: ParsedBlock[] = [{ path: "x.txt", oldText: "line1\nline2", newText: "REPLACED" }];
    autopatchBlocks(blocks, "const line1\\nline2 = 1;\n");
    expect(blocks[0]!.oldText).toBe("line1\\nline2");
  });

  it("skips when original already matches", () => {
    const blocks: ParsedBlock[] = [{ path: "x.txt", oldText: "hello", newText: "world" }];
    autopatchBlocks(blocks, "hello\n");
    expect(blocks[0]!.oldText).toBe("hello");
  });

  it("skips when escaped variant is ambiguous", () => {
    const blocks: ParsedBlock[] = [{ path: "x.txt", oldText: "a\nb", newText: "X" }];
    // "a\\nb" appears twice — ambiguous, must skip.
    autopatchBlocks(blocks, "a\\nb\nother\na\\nb\n");
    expect(blocks[0]!.oldText).toBe("a\nb");
  });

  it("skips when oldText has no literal \\t or \\n", () => {
    const blocks: ParsedBlock[] = [{ path: "x.txt", oldText: "plain text", newText: "other" }];
    autopatchBlocks(blocks, "plain text\n");
    expect(blocks[0]!.oldText).toBe("plain text");
  });
});

// ─── Pass 2: indentation mismatch ────────────────────────────────────────

describe("autopatch indentation mismatch (Pass 2)", () => {
  it("applies tabs→spaces correction when unique", () => {
    const blocks: ParsedBlock[] = [
      { path: "x.txt", oldText: "\tconst x = 1;", newText: "const x = 2;" },
    ];
    autopatchBlocks(blocks, "  const x = 1;\n");
    expect(blocks[0]!.oldText).toBe("  const x = 1;");
  });

  it("skips ambiguous correction", () => {
    const blocks: ParsedBlock[] = [{ path: "x.txt", oldText: "\tconst x = 1;", newText: "X" }];
    autopatchBlocks(blocks, "  const x = 1;\n  const x = 1;\n");
    expect(blocks[0]!.oldText).toBe("\tconst x = 1;");
  });

  it("skips non-indentation-only change", () => {
    const blocks: ParsedBlock[] = [{ path: "x.txt", oldText: "\tconst x = 1;", newText: "X" }];
    // The corrected form changes content, not just indentation.
    autopatchBlocks(blocks, "  const y = 2;\n");
    expect(blocks[0]!.oldText).toBe("\tconst x = 1;");
  });
});

// ─── Integration: executeFile via autopatch ──────────────────────────────

describe("executeFile autopatch integration", () => {
  it("succeeds when oldText has trailing whitespace against a file without it", async () => {
    const files: Record<string, string> = {
      "/tmp/autopatch-test.txt": "foo\nbar\n",
    };

    const result = await executeFile(
      "/tmp/autopatch-test.txt",
      [{ oldText: "foo   ", newText: "baz" }],
      {
        readFile: (p) => Buffer.from(files[p]!, "utf-8"),
        writeFile: (p, data) => {
          files[p] = String(data);
        },
        rename: (from, to) => {
          files[to] = files[from] ?? "";
        },
        exists: () => true,
      },
    );

    expect(result.isError).toBe(false);
    expect(files["/tmp/autopatch-test.txt"]).toBe("baz\nbar\n");
  });
});
