import { describe, it, expect, beforeEach } from "vitest";
import {
  prepareEditArguments,
  describeUnrepairableEditInput,
  repairJsonPunctuation,
  repairMissingKeyQuotes,
  repairLifecycle,
} from "../src/repair/entry.js";

// In-the-wild regression coverage: deepseek-v4-pro nested-path failures
// (15× in one live session) and stepfun malformed JSON-string edits.

describe("hoistNestedPath (in-the-wild: deepseek-v4-pro)", () => {
  beforeEach(() => repairLifecycle.clear());

  it("hoists an identical per-edit path to the root", () => {
    const result = prepareEditArguments({
      edits: [
        { oldText: "a", newText: "b", path: "packages/x/src/file.ts" },
        { oldText: "c", newText: "d", path: "packages/x/src/file.ts" },
      ],
    }) as { path: string; edits: Array<Record<string, unknown>> };

    expect(result.path).toBe("packages/x/src/file.ts");
    for (const edit of result.edits) {
      expect(edit).toEqual({
        oldText: expect.any(String),
        newText: expect.any(String),
      });
    }
  });

  it("hoists when only some edits carry the path and others omit it", () => {
    const result = prepareEditArguments({
      edits: [
        { oldText: "a", newText: "b", path: "f.ts" },
        { oldText: "c", newText: "d" },
      ],
    }) as { path: string };
    expect(result.path).toBe("f.ts");
  });

  it("does not fire when root path already present", () => {
    const input = { path: "root.ts", edits: [{ oldText: "a", newText: "b", path: "nested.ts" }] };
    const result = prepareEditArguments(input) as { path: string; edits: unknown[] };
    expect(result.path).toBe("root.ts");
    expect(result.edits).toHaveLength(1);
  });

  it("fails closed with a split-it message when nested paths disagree", () => {
    const input = {
      edits: [
        { oldText: "a", newText: "b", path: "one.ts" },
        { oldText: "c", newText: "d", path: "two.ts" },
      ],
    };
    let message = "";
    try {
      prepareEditArguments(input);
      expect.unreachable("should have thrown");
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("One edit call can only target ONE file");
    expect(message).toContain('"one.ts"');
    expect(message).toContain('"two.ts"');
  });

  it("normalizes a nested path alias before hoisting", () => {
    const result = prepareEditArguments({
      edits: [{ oldText: "a", newText: "b", file_path: "aliased.ts" }],
    }) as { path: string };
    expect(result.path).toBe("aliased.ts");
  });
});

describe("repairJsonPunctuation (in-the-wild: step-3.7-flash stringified edits)", () => {
  it("strips trailing commas before closers", () => {
    expect(repairJsonPunctuation('[{"a":1,}]')).toBe('[{"a":1}]');
    expect(repairJsonPunctuation('{"a":[1,2,],"b":3}')).toBe('{"a":[1,2],"b":3}');
  });

  it("drops a terminated dangling quoted fragment before a closer", () => {
    expect(JSON.parse(repairJsonPunctuation('{"k": "v", "junk"}'))).toEqual({ k: "v" });
  });

  it("drops an unterminated stray quote before a closer", () => {
    expect(JSON.parse(repairJsonPunctuation('{"k": "v", "}'))).toEqual({ k: "v" });
  });

  it("never touches commas or quotes inside string literals", () => {
    const raw = '{"t":"text with, comma and \\" quote","u":"end"}';
    expect(repairJsonPunctuation(raw)).toBe(raw);
  });

  it("leaves valid JSON untouched", () => {
    const raw = '{"edits":[{"oldText":"a, b] c","newText":"d"}]}';
    expect(repairJsonPunctuation(raw)).toBe(raw);
  });
});

describe("repairMissingKeyQuotes (in-the-wild: glm-5.3 stringified edits, 2026-11-21)", () => {
  beforeEach(() => repairLifecycle.clear());

  it("re-quotes a bare key after a value (the observed oldText shape)", () => {
    const raw = '[{"newText":"AAA",oldText":"BBB"}]';
    const repaired = repairMissingKeyQuotes(raw);
    expect(repaired).toBe('[{"newText":"AAA","oldText":"BBB"}]');
    expect(JSON.parse(repaired)).toEqual([{ newText: "AAA", oldText: "BBB" }]);
  });

  it("repairs every corrupted key in one pass (multi-entry payload)", () => {
    const raw = '[{"newText":"a",oldText":"b"}, {"newText":"c",oldText":"d"}]';
    expect(JSON.parse(repairMissingKeyQuotes(raw))).toEqual([
      { newText: "a", oldText: "b" },
      { newText: "c", oldText: "d" },
    ]);
  });

  it("repairs a missing quote on the FIRST key of an object", () => {
    const raw = '[{oldText":"a", "newText":"b"}]';
    expect(JSON.parse(repairMissingKeyQuotes(raw))).toEqual([{ oldText: "a", newText: "b" }]);
  });

  it("tolerates the observed spacing variant (space after the colon)", () => {
    const raw = '[{"newText": "AAA",oldText": "BBB"}]';
    expect(JSON.parse(repairMissingKeyQuotes(raw))).toEqual([{ newText: "AAA", oldText: "BBB" }]);
  });

  it("never inserts quotes inside string literals", () => {
    // The newText value itself contains an `oldText":`-lookalike, escaped as
    // in the wild payloads — the scanner must stay in string mode there and
    // only repair the structural corruption after the value.
    const raw = `[{"newText":"text with oldText\\": inside",oldText":"BBB"}]`;
    const parsed = JSON.parse(repairMissingKeyQuotes(raw)) as Array<Record<string, string>>;
    expect(parsed[0]?.newText).toBe('text with oldText": inside');
    expect(parsed[0]?.oldText).toBe("BBB");
  });

  it("leaves bare identifiers at value positions alone (fail closed)", () => {
    const raw = '[{"newText":bare"}]';
    expect(repairMissingKeyQuotes(raw)).toBe(raw);
  });

  it("leaves identifiers without an abutting closing quote alone", () => {
    const raw = '[{"newText":"a",oldText :"b"}]';
    expect(repairMissingKeyQuotes(raw)).toBe(raw);
  });

  it("returns the input unchanged on closer/stack mismatch (under-escape debris)", () => {
    // Premature string close leaves the frame stack desynced — a different
    // corruption; the under-escape attempt owns this shape.
    const raw = '[{"newText":"glob ts"],"oldText":"b"}]';
    expect(repairMissingKeyQuotes(raw)).toBe(raw);
  });

  it("is a no-op on valid JSON", () => {
    const raw = '{"edits":[{"oldText":"a","newText":"b"}]}';
    expect(repairMissingKeyQuotes(raw)).toBe(raw);
  });

  it("wins over the under-escape glue: pipeline yields separate oldText/newText", () => {
    // Reduced from the wild glm-5.3 session: without the missing-key pass
    // the under-escape rounds produced a wrong-but-valid parse gluing
    // oldText's content into the newText value.
    const raw = '[{"newText":"const a = 1;",oldText":"const a = 2;"}]';
    const prepared = prepareEditArguments({ path: "x.ts", edits: raw }) as {
      edits: Array<{ oldText: string; newText: string }>;
    };
    expect(prepared.edits).toEqual([{ newText: "const a = 1;", oldText: "const a = 2;" }]);
  });
});

describe("prepareEditArguments — malformed stringified edits", () => {
  it("parses a stringified array with a trailing comma", () => {
    const result = prepareEditArguments({
      path: "tsconfig.json",
      edits: '[{"newText": "b", "oldText": "a",}]',
    }) as { edits: Array<{ oldText: string; newText: string }> };
    expect(result.edits).toEqual([{ oldText: "a", newText: "b" }]);
  });

  it("parses the exact wild payload shape (dangling quote after value)", () => {
    // Reproduces the stepfun shape: "<value>", "}  — trailing comma plus a
    // stray quote directly before the closing brace.
    const editsString =
      '[{"newText": "  \\"include\\": [\\"src/**/*.ts\\"]", "oldText": "  \\"include\\": [\\"src/**/*.ts\\", \\"extension.ts\\"],"}]';
    const result = prepareEditArguments({ path: "tsconfig.json", edits: editsString }) as {
      edits: Array<{ oldText: string; newText: string }>;
    };
    expect(result.edits).toHaveLength(1);
    expect(result.edits[0]?.newText).toContain('"include"');
  });

  it("enriches the unrepairable error for unparseable strings", () => {
    let message = "";
    try {
      prepareEditArguments({ path: "x.ts", edits: "[{oldText: not json}" });
      expect.unreachable("should have thrown");
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("edits must be a JSON array of objects");
  });
});

describe("describeUnrepairableEditInput", () => {
  it("reports parse failure reason for bad strings", () => {
    const hint = describeUnrepairableEditInput({ edits: "[{broken" });
    expect(hint).toContain("double-encoded JSON STRING");
  });

  it("reports when the string parses but is not an array", () => {
    const hint = describeUnrepairableEditInput({ edits: '"just a string"' });
    expect(hint).toContain("is not an array");
  });

  it("lists disagreeing nested paths", () => {
    const hint = describeUnrepairableEditInput({
      edits: [
        { oldText: "a", newText: "b", path: "one.ts" },
        { oldText: "c", newText: "d", path: "two.ts" },
      ],
    });
    expect(hint).toContain("ONE file");
    expect(hint).toContain("one.ts");
    expect(hint).toContain("two.ts");
  });

  it("returns null for ordinary invalid input", () => {
    expect(describeUnrepairableEditInput({ path: 42 })).toBeNull();
  });
});

describe("dropEmptyEditObjects (in-the-wild: native-era {} placeholders, 90+ calls)", () => {
  beforeEach(() => repairLifecycle.clear());

  it("drops a leading {} placeholder and keeps the real edit", () => {
    const out = prepareEditArguments({
      path: "a.ts",
      edits: [{}, { oldText: "x", newText: "y" }],
    }) as { edits: Array<Record<string, unknown>> };
    expect(out.edits).toEqual([{ oldText: "x", newText: "y" }]);
  });

  it("drops interleaved placeholders", () => {
    const out = prepareEditArguments({
      path: "a.ts",
      edits: [{ oldText: "a", newText: "b" }, {}, { oldText: "c", newText: "d" }, {}],
    }) as { edits: unknown[] };
    expect(out.edits).toHaveLength(2);
  });

  it("reduces an all-placeholder call to an empty array (honest min-items failure)", () => {
    const out = prepareEditArguments({ path: "a.ts", edits: [{}, {}] }) as { edits: unknown[] };
    expect(out.edits).toHaveLength(0);
  });

  it("never fires on non-empty objects", () => {
    const args = { path: "a.ts", edits: [{ oldText: "x", newText: "" }] };
    const out = prepareEditArguments(args) as { edits: unknown[] };
    expect(out.edits).toHaveLength(1);
  });
});

describe("inferDeletionMissingNewText (in-the-wild: ~50 oldText-only calls)", () => {
  beforeEach(() => repairLifecycle.clear());

  it('interprets oldText-only as deletion (newText: "")', () => {
    const out = prepareEditArguments({
      path: "a.ts",
      edits: [{ oldText: "  console.log(" }],
    }) as { edits: Array<{ oldText: string; newText: string }> };
    expect(out.edits[0]).toEqual({ oldText: "  console.log(", newText: "" });
  });

  it("covers aliased old_string-only shapes", () => {
    const out = prepareEditArguments({
      path: "a.ts",
      edits: [{ old_string: "x" }],
    }) as { edits: Array<{ oldText: string; newText: string }> };
    expect(out.edits[0].newText).toBe("");
  });

  it("preserves anchor and replaceAll when inferring deletion", () => {
    const out = prepareEditArguments({
      path: "a.ts",
      edits: [{ anchor: "// hdr", oldText: "x", replaceAll: true }],
    }) as {
      edits: Array<{ anchor: string; oldText: string; replaceAll: boolean; newText: string }>;
    };
    expect(out.edits[0].newText).toBe("");
    expect(out.edits[0].anchor).toBe("// hdr");
    expect(out.edits[0].replaceAll).toBe(true);
  });

  it("does not fire when newText is present", () => {
    const out = prepareEditArguments({
      path: "a.ts",
      edits: [{ oldText: "a", newText: "b" }],
    }) as { edits: Array<{ oldText: string; newText: string }> };
    expect(out.edits[0].newText).toBe("b");
  });

  it("does not fire on empty oldText", () => {
    const raw = { path: "a.ts", edits: [{ oldText: "", newText: "b" }] };
    const out = prepareEditArguments(raw) as { edits: Array<{ oldText: string; newText: string }> };
    expect(out.edits[0].newText).toBe("b");
  });
});

describe("inferInsertionMissingOldText (in-the-wild: 10 stepfun insertion calls)", () => {
  beforeEach(() => repairLifecycle.clear());

  it("derives oldText from the anchor when newText embeds it verbatim", () => {
    const out = prepareEditArguments({
      path: "a.sh",
      edits: [
        {
          anchor: 'echo "End of script"',
          newText: 'echo "End of script"\necho "Final line added in pass 1"',
        },
      ],
    }) as { edits: Array<{ oldText: string; newText: string; anchor?: string }> };
    expect(out.edits[0].oldText).toBe('echo "End of script"');
    expect(out.edits[0].newText).toContain('echo "Final line added in pass 1"');
  });

  it("does not fire when the anchor is absent from newText", () => {
    const raw = {
      path: "a.ts",
      edits: [{ anchor: "totally unrelated", newText: "brand new content" }],
    };
    expect(() => prepareEditArguments(raw)).toThrow(/no `oldText`[\s\S]*INSERT/);
  });

  it("hints instead of repairing when there is no anchor at all", () => {
    const raw = { path: "a.ts", edits: [{ newText: "brand new content" }] };
    expect(() => prepareEditArguments(raw)).toThrow(/edits\[0\][\s\S]*INSERT/);
  });

  it("does not fire when oldText is present", () => {
    const out = prepareEditArguments({
      path: "a.ts",
      edits: [{ oldText: "x", newText: "y", anchor: "x" }],
    }) as { edits: Array<{ oldText: string }> };
    expect(out.edits[0].oldText).toBe("x");
  });
});
