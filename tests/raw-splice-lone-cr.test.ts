// Regression tests for the lone-\r norm→raw offset bug.
//
// normalizeNewlines folds CRLF *and lone CR* to LF. buildNormToRawMap
// advanced ri += 2 whenever it saw a normalized \n over a raw \r — correct
// for CRLF, but for a lone \r that skips the byte AFTER the CR, corrupting
// every subsequent offset. Mined from a stale audit pass; proven here.

import { describe, it, expect } from "vitest";
import { buildNormToRawMap, spliceOntoRaw } from "../src/edit/patching/raw-splice.js";
import { normalizeNewlines } from "../src/edit/text.js";
import { findAllSpans } from "../src/edit/pipeline/resolve.js";

describe("buildNormToRawMap", () => {
  it("maps lone \\r characters without skipping the following byte", () => {
    const raw = "a\rb"; // lone CR — normalizes to "a\nb"
    const norm = normalizeNewlines(raw);
    expect(norm).toBe("a\nb");

    const map = buildNormToRawMap(raw, norm);
    expect(map[0]).toBe(0); // 'a'
    expect(map[1]).toBe(1); // '\n' came from raw[1] ('\r')
    expect(map[2]).toBe(2); // 'b' — was skipped past before the fix
    expect(map[3]).toBe(3); // end sentinel
  });

  it("still maps CRLF pairs with the two-byte advance", () => {
    const raw = "a\r\nb";
    const norm = normalizeNewlines(raw);
    expect(norm).toBe("a\nb");

    const map = buildNormToRawMap(raw, norm);
    expect(map[0]).toBe(0); // 'a'
    expect(map[1]).toBe(1); // '\n' from the \r\n pair
    expect(map[2]).toBe(3); // 'b' after the pair
    expect(map[3]).toBe(4);
  });

  it("mixed endings keep every offset aligned", () => {
    const raw = "x\r\ny\rz\nw";
    const norm = normalizeNewlines(raw);
    expect(norm).toBe("x\ny\nz\nw");

    const map = buildNormToRawMap(raw, norm);
    // norm: x(0) \n(1) y(2) \n(3) z(4) \n(5) w(6)
    expect([...map]).toEqual([0, 1, 3, 4, 5, 6, 7, 8]);
  });
});

describe("spliceOntoRaw with lone-CR content", () => {
  it("splices at the right offset when untouched regions contain lone CRs", () => {
    // The lone \r sits BEFORE the splice target — offsets after it were
    // corrupted pre-fix, so the replacement landed one byte early.
    const raw = "keep\rintact\r\nTARGET old";
    const norm = normalizeNewlines(raw); // both CRs collapse — offsets shift
    const result = spliceOntoRaw(raw, [
      { normStart: norm.indexOf("TARGET"), normEnd: norm.length, newStr: "TARGET new" },
    ]);
    expect(result).toBe("keep\rintact\r\nTARGET new");
  });

  it("lone CR immediately before the splice region", () => {
    const raw = "head\rtail";
    const result = spliceOntoRaw(raw, [{ normStart: 5, normEnd: 9, newStr: "TAIL" }]);
    expect(result).toBe("head\rTAIL");
  });
});

describe("findAllSpans empty-needle guard", () => {
  it("returns no spans for an empty needle instead of looping forever", () => {
    // Pre-guard this spun forever (indexOf("", from) === from).
    expect(findAllSpans("abc", "")).toEqual([]);
  });
});
