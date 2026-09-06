import { describe, it, expect } from "vitest";
import { robustTrimmedFind, robustBackslashFind } from "../src/edit/matching/robust-match.js";
import { findMatch } from "../src/edit/matching/chain.js";

describe("robustTrimmedFind", () => {
  it("matches when file has trailing whitespace but query doesn't", () => {
    const original = "hello world   \nfoo bar  \n";
    const query = "hello world\nfoo bar";
    const result = robustTrimmedFind(original, query);
    expect(result).not.toBeNull();
    expect(result).toBe("hello world   \nfoo bar  \n");
  });

  it("returns null when there is no trailing whitespace to strip", () => {
    const original = "hello world\nfoo bar";
    const query = "hello world\nfoo bar";
    const result = robustTrimmedFind(original, query);
    expect(result).toBeNull(); // simpleFind handles this
  });

  it("returns null when trimmed query is ambiguous", () => {
    const original = "hello world   \nfoo bar   \nhello world   \nfoo bar   \n";
    const query = "hello world\nfoo bar";
    const result = robustTrimmedFind(original, query);
    expect(result).toBeNull();
  });

  it("returns null when trimmed content doesn't match", () => {
    const original = "hello world   \nfoo bar  \n";
    const query = "goodbye world\nfoo bar";
    const result = robustTrimmedFind(original, query);
    expect(result).toBeNull();
  });
});

describe("robustBackslashFind", () => {
  it("matches when file has bare quotes but query has escaped quotes", () => {
    const original = 'const msg = "hello";\n';
    const query = 'const msg = \\"hello\\";\n';
    const result = robustBackslashFind(original, query);
    expect(result).not.toBeNull();
    expect(result).toBe('const msg = "hello";\n');
  });

  it("matches when file has escaped quotes but query has bare quotes", () => {
    const original = 'const msg = \\"hello\\";\n';
    const query = 'const msg = "hello";\n';
    const result = robustBackslashFind(original, query);
    expect(result).not.toBeNull();
    expect(result).toBe('const msg = \\"hello\\";\n');
  });

  it("returns null when no backslash variants match", () => {
    const original = "hello world\n";
    const query = "goodbye world\n";
    const result = robustBackslashFind(original, query);
    expect(result).toBeNull();
  });

  it("returns null for ambiguous backslash matches", () => {
    const original = '"hello"\n"hello"\n';
    const query = '\\"hello\\"\n';
    const result = robustBackslashFind(original, query);
    expect(result).toBeNull();
  });
});

describe("chain pass selection — which pass actually wins (empirical)", () => {
  // Pins the pass-winner semantics of the full 12-pass REPLACER_CHAIN so the
  // shadowing relationships can't regress silently:
  //
  //   1. Classic trailing-whitespace drift (file has trailing ws, query
  //      doesn't) is claimed by line_trimmed (pass 2) BEFORE robust_trimmed
  //      runs — robust_trimmed's plain case is subsumed. This is why the
  //      robustTrimmedFind unit tests call it directly; through the chain it
  //      only wins in case 4 below.
  //   2. Bare-quote query vs escaped-quote file reaches robust_backslash
  //      (pass 12) — the "model forgot to escape" direction.
  //   3. The reverse (escaped-query vs bare-file) is claimed earlier by
  //      escape_normalized (pass 6), so robust_backslash's strip-backslash
  //      variant never wins in the chain.
  //   4. robust_trimmed is only reachable when the query is a line-boundary-
  //      crossing PREFIX of a trimmed file line: line_trimmed needs exact
  //      per-line trim equality, and context_aware is defeated by the low
  //      similarity of the trailing junk.

  it("line_trimmed claims the classic trailing-whitespace case", () => {
    const m = findMatch("hello world   \nfoo bar  \n", "hello world\nfoo bar");
    expect(m?.passName).toBe("line_trimmed");
    expect(m?.actual).toBe("hello world   \nfoo bar  ");
  });

  it("robust_backslash wins bare-quote query vs escaped-quote file", () => {
    const m = findMatch('const msg = \\"hello\\";\n', 'const msg = "hello";\n');
    expect(m?.passName).toBe("robust_backslash");
    expect(m?.actual).toBe('const msg = \\"hello\\";\n');
  });

  it("escape_normalized claims escaped-query vs bare-quote file (before robust_backslash)", () => {
    const m = findMatch('const msg = "hello";\n', 'const msg = \\"hello\\";\n');
    expect(m?.passName).toBe("escape_normalized");
  });

  it("robust_trimmed wins the line-boundary-crossing prefix case", () => {
    const m = findMatch(
      "const a = 1;   \nconst b = 2;   // this trailing comment is intentionally very long and was appended later by another tool\n",
      "const a = 1;\nconst b = 2;",
    );
    expect(m?.passName).toBe("robust_trimmed");
    // The match absorbs each file line's trailing whitespace, so the
    // replacement lands cleanly before the appended comment.
    expect(m?.actual).toBe("const a = 1;   \nconst b = 2;   ");
  });
});
