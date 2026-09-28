/**
 * Whole-line trailing-whitespace expansion — when a single-line query names
 * a line modulo surrounding whitespace, the match widens to cover the
 * line's trailing whitespace so a full-line replace strips it (benchmark
 * whitespace-only: `bbb` against `bbb␣␣` must yield `BBB`, not `BBB␣␣`).
 *
 * Mid-line tokens are untouched: expansion requires the query to equal the
 * whole line after trim, so sub-line-token (`limit=100` inside a long URL
 * line) and replace-all (`deploy` inside YAML lines) keep substring
 * semantics. Leading indentation is never absorbed — only the tail widens.
 */
import { describe, it, expect } from "vitest";
import { findMatch, isWhitespaceTolerantMatch } from "../src/edit/matching/chain.js";
import { executeFile } from "../src/edit/pipeline/execute.js";

describe("whole-line trailing expansion in findMatch", () => {
  it("widens a substring hit to cover trailing spaces", () => {
    const hit = findMatch("aaa\nbbb  \nccc\n", "bbb");
    expect(hit?.actual).toBe("bbb  ");
    expect(hit?.passName).toBe("simple");
  });

  it("leaves an already whole-line hit alone", () => {
    const hit = findMatch("aaa\nbbb\nccc\n", "bbb");
    expect(hit?.actual).toBe("bbb");
  });

  it("preserves leading indentation (tail only)", () => {
    const hit = findMatch("aaa\n  bbb  \nccc\n", "bbb");
    expect(hit?.actual).toBe("bbb  ");
  });

  it("does not expand mid-line tokens", () => {
    const line = '  const endpoint = "https://api.example.com/v1/resources?limit=100&sort=asc";';
    const hit = findMatch(`${line}\n`, "limit=100");
    expect(hit?.actual).toBe("limit=100");
  });

  it("does not expand partial-line prefixes", () => {
    const hit = findMatch("aaabbb\n", "bbb");
    expect(hit?.actual).toBe("bbb");
  });

  it("does not expand multi-line queries", () => {
    const hit = findMatch("aaa\nbbb  \nccc\n", "aaa\nbbb  ");
    expect(hit?.actual).toBe("aaa\nbbb  ");
  });

  it("does not expand when the query is longer than the trimmed line", () => {
    const hit = findMatch("bbb\n", "bbb extra");
    expect(hit).toBeNull();
  });
});

describe("isWhitespaceTolerantMatch single-line rule", () => {
  // Stale-read guard support: a bare substring inside a longer drifted line
  // is content drift, not whitespace drift (benchmark stale-line/b9).
  it("rejects a substring inside a longer drifted line", () => {
    expect(isWhitespaceTolerantMatch("aaa\nbbb-external\nccc\n", "bbb")).toBe(false);
  });

  it("accepts a trim-equal line with trailing spaces", () => {
    expect(isWhitespaceTolerantMatch("aaa\nbbb  \nccc\n", "bbb")).toBe(true);
  });

  it("accepts an indent-only difference", () => {
    expect(isWhitespaceTolerantMatch("function f() {\n    return 1;\n}\n", "  return 1;")).toBe(
      true,
    );
  });

  it("accepts genuine intra-line respace via collapse", () => {
    expect(isWhitespaceTolerantMatch("read a  b c\n", "read a b c")).toBe(true);
  });

  it("rejects mid-line tokens (never whole-line candidates)", () => {
    expect(isWhitespaceTolerantMatch('const x = "limit=100";\n', "limit=100")).toBe(false);
  });
});

describe("whitespace-only end to end", () => {
  async function runOnce(content: string, oldText: string, newText: string): Promise<string> {
    const path = "/bench/ws.ts";
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
    expect(result.isError).toBe(false);
    return store.get(path)!.toString("utf-8");
  }

  it("strips trailing spaces on a full-line replace", async () => {
    expect(await runOnce("aaa\nbbb  \nccc\n", "bbb", "BBB")).toBe("aaa\nBBB\nccc\n");
  });

  it("keeps substring semantics inside longer lines", async () => {
    const line = '  const endpoint = "https://api.example.com/v1/resources?limit=100&sort=asc";';
    const out = await runOnce(`${line}\n`, "limit=100", "limit=250");
    expect(out).toBe(`${line.replace("limit=100", "limit=250")}\n`);
  });
});
