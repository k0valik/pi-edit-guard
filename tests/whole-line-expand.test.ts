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
import { findMatch } from "../src/edit/matching/chain.js";
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
