import { describe, it, expect } from "vitest";
import {
  normalizeLineEndings,
  buildNormToRawMap,
  spliceOntoRaw,
  buildLineOffsets,
  lineAtOffset,
  offsetAtLine,
} from "../src/edit/patching/raw-splice.js";

describe("normalizeLineEndings", () => {
  it("converts CRLF to LF", () => {
    expect(normalizeLineEndings("hello\r\nworld")).toBe("hello\nworld");
  });

  it("converts lone CR to LF", () => {
    expect(normalizeLineEndings("hello\rworld")).toBe("hello\nworld");
  });

  it("preserves LF", () => {
    expect(normalizeLineEndings("hello\nworld")).toBe("hello\nworld");
  });

  it("handles mixed line endings", () => {
    expect(normalizeLineEndings("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });
});

describe("buildNormToRawMap", () => {
  it("maps identical strings 1:1", () => {
    const map = buildNormToRawMap("hello", "hello");
    expect(map[0]).toBe(0);
    expect(map[5]).toBe(5);
  });

  it("skips CR in CRLF pairs", () => {
    const raw = "hello\r\nworld";
    const norm = "hello\nworld";
    const map = buildNormToRawMap(raw, norm);
    expect(map[0]).toBe(0); // 'h'
    expect(map[5]).toBe(5); // '\n' in norm → '\r' in raw (index 5)
    expect(map[6]).toBe(7); // 'w' in norm → 'w' in raw (index 7, after \r\n)
    expect(map[10]).toBe(11); // end
  });

  it("handles multiple CRLF sequences", () => {
    const raw = "a\r\nb\r\nc";
    const norm = "a\nb\nc";
    const map = buildNormToRawMap(raw, norm);
    expect(map[0]).toBe(0); // 'a'
    expect(map[1]).toBe(1); // '\n' → '\r' in raw
    expect(map[2]).toBe(3); // 'b'
    expect(map[3]).toBe(4); // '\n' → '\r' in raw
    expect(map[4]).toBe(6); // 'c'
    expect(map[5]).toBe(7); // end of raw
  });
});

describe("spliceOntoRaw", () => {
  it("preserves CRLF in untouched regions", () => {
    const raw = "hello\r\nworld";
    const splices = [{ normStart: 6, normEnd: 11, newStr: "EARTH" }];
    const result = spliceOntoRaw(raw, splices);
    expect(result).toBe("hello\r\nEARTH");
  });

  it("handles multiple splices", () => {
    const raw = "a\r\nb\r\nc";
    // Replace 'a' and 'c' in normalized coords
    const splices = [
      { normStart: 0, normEnd: 1, newStr: "X" },
      { normStart: 4, normEnd: 5, newStr: "Z" },
    ];
    const result = spliceOntoRaw(raw, splices);
    expect(result).toBe("X\r\nb\r\nZ");
  });

  it("returns original when no splices", () => {
    expect(spliceOntoRaw("hello", [])).toBe("hello");
  });

  it("handles LF-only files (no CR to skip)", () => {
    const raw = "hello\nworld";
    const splices = [{ normStart: 0, normEnd: 5, newStr: "HELLO" }];
    const result = spliceOntoRaw(raw, splices);
    expect(result).toBe("HELLO\nworld");
  });

  it("handles replacement that changes length", () => {
    const raw = "short\r\ntext";
    const splices = [{ normStart: 0, normEnd: 5, newStr: "much longer replacement" }];
    const result = spliceOntoRaw(raw, splices);
    expect(result).toBe("much longer replacement\r\ntext");
  });
});

describe("buildLineOffsets", () => {
  it("returns offsets for each line", () => {
    const offsets = buildLineOffsets("a\nb\nc");
    expect(offsets).toEqual([0, 2, 4, 5]);
  });

  it("handles no trailing newline", () => {
    const offsets = buildLineOffsets("a\nb");
    expect(offsets).toEqual([0, 2, 3]);
  });

  it("handles empty string", () => {
    const offsets = buildLineOffsets("");
    expect(offsets).toEqual([0]);
  });
});

describe("lineAtOffset", () => {
  const offsets = buildLineOffsets("line1\nline2\nline3");

  it("returns 1 for offset 0", () => {
    expect(lineAtOffset(offsets, 0)).toBe(1);
  });

  it("returns 2 for offset in second line", () => {
    expect(lineAtOffset(offsets, 6)).toBe(2);
  });

  it("returns 3 for offset in third line", () => {
    expect(lineAtOffset(offsets, 12)).toBe(3);
  });
});

describe("offsetAtLine", () => {
  const offsets = buildLineOffsets("line1\nline2\nline3");

  it("returns offset for line 1", () => {
    expect(offsetAtLine(offsets, 1)).toBe(0);
  });

  it("returns offset for line 2", () => {
    expect(offsetAtLine(offsets, 2)).toBe(6);
  });

  it("returns offset for line 3", () => {
    expect(offsetAtLine(offsets, 3)).toBe(12);
  });
});
