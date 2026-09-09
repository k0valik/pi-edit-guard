import { describe, it, expect, beforeEach } from "vitest";
import { Value } from "typebox/value";
import { getConfig } from "../src/config/settings.js";
import { EDIT_SCHEMA, prepareEditArguments, repairLifecycle } from "../src/repair/entry.js";
import { EDIT_FIELD_ALIASES } from "../src/repair/aliases.js";

const VALID = {
  path: "/tmp/x.txt",
  edits: [{ oldText: "a", newText: "b" }],
};

describe("prepareEditArguments", () => {
  beforeEach(() => {
    repairLifecycle.clear();
  });

  it("passes strictly valid input through untouched (same reference)", () => {
    const result = prepareEditArguments(VALID);
    expect(result).toBe(VALID);
    expect(repairLifecycle.pendingCount).toBe(0);
  });

  it("renames aliases at any depth (path alias + snake_case elements)", () => {
    const result = prepareEditArguments({
      file_path: "/tmp/x.txt",
      edits: [{ old_string: "a", new_str: "b" }],
    }) as { path: string; edits: Array<{ oldText: string; newText: string }> };
    expect(result.path).toBe("/tmp/x.txt");
    expect(result.edits[0]).toEqual({ oldText: "a", newText: "b" });
  });

  it("renames the full upstream alias surface (absolutePath, old_text, new_content)", () => {
    const result = prepareEditArguments({
      absolutePath: "/tmp/x.txt",
      edits: [{ old_text: "a", new_content: "b" }],
    }) as { path: string; edits: Array<{ oldText: string; newText: string }> };
    expect(result.path).toBe("/tmp/x.txt");
    expect(result.edits[0]).toEqual({ oldText: "a", newText: "b" });
  });

  it("renames EVERY alias in the upstream table to its canonical field", () => {
    for (const [canonical, aliases] of Object.entries(EDIT_FIELD_ALIASES)) {
      for (const alias of aliases) {
        repairLifecycle.clear();
        const edit =
          canonical === "oldText"
            ? { [alias]: "a", newText: "b" }
            : canonical === "newText"
              ? { oldText: "a", [alias]: "b" }
              : { oldText: "a", newText: "b" };
        const input =
          canonical === "path"
            ? { [alias]: "/tmp/x.txt", edits: [edit] }
            : { path: "/tmp/x.txt", edits: [edit] };

        const result = prepareEditArguments(input) as {
          path: string;
          edits: Array<{ oldText: string; newText: string }>;
        };
        expect(result.path, `${canonical} via ${alias}`).toBe("/tmp/x.txt");
        expect(result.edits[0].oldText, `${canonical} via ${alias}`).toBe("a");
        expect(result.edits[0].newText, `${canonical} via ${alias}`).toBe("b");

        const feedback = repairLifecycle.correlate("edit", result, `call-${canonical}-${alias}`);
        expect(
          feedback?.notes.some((n) => n.includes(`\`${alias}\``)),
          `${canonical} via ${alias} should teach the correct field`,
        ).toBe(true);
      }
    }
  });

  it("notes each widened alias rename so the model self-corrects next turn", () => {
    const result = prepareEditArguments({
      targetFile: "/tmp/x.txt",
      edits: [{ old: "a", new: "b" }],
    }) as typeof VALID;
    const feedback = repairLifecycle.correlate("edit", result, "call-widen");
    expect(feedback?.notes.some((n) => n.includes("`targetFile`"))).toBe(true);
    expect(feedback?.notes.some((n) => n.includes("`old`"))).toBe(true);
    expect(feedback?.notes.some((n) => n.includes("`new`"))).toBe(true);
  });

  it("canonical field wins over an alias twin (no clobber)", () => {
    const result = prepareEditArguments({
      path: "/tmp/canonical.txt",
      absolute_path: "/tmp/alias.txt",
      edits: [{ oldText: "a", newText: "b" }],
    }) as { path: string };
    expect(result.path).toBe("/tmp/canonical.txt");
  });

  it("decodes a JSON-string envelope", () => {
    const result = prepareEditArguments(JSON.stringify(VALID)) as typeof VALID;
    expect(result).toEqual(VALID);
    const feedback = repairLifecycle.correlate("edit", result, "call-1");
    expect(feedback?.notes.some((n) => n.includes("JSON-stringified arguments"))).toBe(true);
  });

  it("completes a truncated JSON object envelope when the candidate validates", () => {
    // Only the final closing brace is missing; the suffix completes the object.
    const truncated = '{"path": "/tmp/x.txt", "edits": [{"oldText": "a", "newText": "b"}]';
    const result = prepareEditArguments(truncated) as typeof VALID;
    expect(result).toEqual(VALID);
  });

  it("folds flat oldText/newText into edits (native parity, camelCase)", () => {
    const result = prepareEditArguments({
      path: "/tmp/x.txt",
      oldText: "a",
      newText: "b",
    }) as typeof VALID;
    expect(result.edits).toEqual([{ oldText: "a", newText: "b" }]);
  });

  it("folds flat snake_case old_str/new_str into edits", () => {
    const result = prepareEditArguments({
      path: "/tmp/x.txt",
      old_str: "a",
      new_str: "b",
      anchor: "ctx",
    }) as typeof VALID;
    expect(result.edits).toEqual([{ oldText: "a", newText: "b", anchor: "ctx" }]);
  });

  it("appends flat keys to an existing edits array (native parity)", () => {
    const result = prepareEditArguments({
      path: "/tmp/x.txt",
      edits: [{ oldText: "a", newText: "b" }],
      oldText: "c",
      newText: "d",
    }) as typeof VALID;
    expect(result.edits).toHaveLength(2);
    expect(result.edits[1]).toEqual({ oldText: "c", newText: "d" });
  });

  it("parses a JSON-stringified edits array with literal newlines inside string values", () => {
    const raw = '[{"oldText": "line1' + "\n" + 'line2", "newText": "x"}]';
    const result = prepareEditArguments({
      path: "/tmp/x.txt",
      edits: raw,
    }) as typeof VALID;
    expect(result.edits).toEqual([{ oldText: "line1\nline2", newText: "x" }]);
  });

  it("renames snake_case keys inside stringified edits after parsing", () => {
    const result = prepareEditArguments({
      path: "/tmp/x.txt",
      edits: '[{"old_string": "a", "new_string": "b"}]',
    }) as typeof VALID;
    expect(result.edits).toEqual([{ oldText: "a", newText: "b" }]);
  });

  it("filters empty-string entries from edits[]", () => {
    const result = prepareEditArguments({
      path: "/tmp/x.txt",
      edits: ["", { oldText: "a", newText: "b" }],
    }) as { path: string; edits: Array<{ oldText: string; newText: string }> };
    expect(result.edits).toEqual([{ oldText: "a", newText: "b" }]);
  });

  it("filters empty-string entries from edits[] when repair is disabled", () => {
    const prev = (getConfig() as { repairEnabled: boolean }).repairEnabled;
    try {
      (getConfig() as { repairEnabled: boolean }).repairEnabled = false;
      const result = prepareEditArguments({
        path: "/tmp/x.txt",
        edits: ["", { oldText: "a", newText: "b" }],
      }) as { path: string; edits: Array<{ oldText: string; newText: string }> };
      expect(result.edits).toEqual([{ oldText: "a", newText: "b" }]);
    } finally {
      (getConfig() as { repairEnabled: boolean }).repairEnabled = prev;
    }
  });

  it("throws the retry message on the unrepairable path", () => {
    expect(() => prepareEditArguments({ path: 42 })).toThrow(/Invalid input for tool "edit"/);
  });

  it("does not enqueue notes for the unrepairable path", () => {
    try {
      prepareEditArguments({ path: 42 });
    } catch {
      // expected
    }
    expect(repairLifecycle.pendingCount).toBe(0);
  });
});

describe("repairLifecycle note channel", () => {
  beforeEach(() => {
    repairLifecycle.clear();
  });

  it("round-trips repair notes from prepare to execute (enqueue → correlate → take)", () => {
    const repaired = prepareEditArguments({
      file_path: "/tmp/x.txt",
      edits: [{ old_string: "a", new_string: "b" }],
    });
    expect(repairLifecycle.pendingCount).toBe(1);

    const feedback = repairLifecycle.correlate("edit", repaired, "call-42");
    expect(feedback).toBeDefined();
    expect(feedback!.rules.length).toBeGreaterThan(0);
    expect(feedback!.notes.length).toBeGreaterThan(0);
    expect(feedback!.notes[0]).toContain('tool "edit"');
    expect(repairLifecycle.pendingCount).toBe(0);

    const taken = repairLifecycle.take("call-42");
    expect(taken).toEqual(feedback);
    expect(repairLifecycle.take("call-42")).toBeUndefined(); // single-use
  });

  it("correlation survives pi's Value.Convert between prepareArguments and execute", () => {
    const repaired = prepareEditArguments({
      file_path: "/tmp/x.txt",
      edits: [{ old_string: "a", new_string: "b" }],
    }) as typeof VALID;
    // pi runs Value.Convert on the prepared args before execute
    const converted = Value.Convert(EDIT_SCHEMA, structuredClone(repaired));
    expect(converted).toEqual(repaired);

    const feedback = repairLifecycle.correlate("edit", converted, "call-7");
    expect(feedback).toBeDefined();
    expect(feedback!.notes.length).toBeGreaterThan(0);
  });

  it("missed correlation is harmless: notes lost, nothing attached", () => {
    prepareEditArguments({
      file_path: "/tmp/x.txt",
      edits: [{ old_string: "a", new_string: "b" }],
    });
    // execute sees different args (e.g. Convert changed serialization)
    const feedback = repairLifecycle.correlate("edit", { path: "/other" }, "call-1");
    expect(feedback).toBeUndefined();
    expect(repairLifecycle.take("call-1")).toBeUndefined();
  });

  it("correlation is single-use and keyed by (toolName, serialized args)", () => {
    const repaired = prepareEditArguments({
      file_path: "/tmp/x.txt",
      edits: [{ old_string: "a", new_string: "b" }],
    });
    const first = repairLifecycle.correlate("edit", repaired, "call-1");
    expect(first).toBeDefined();
    // A second correlate with the same args finds nothing (already consumed)
    expect(repairLifecycle.correlate("edit", repaired, "call-2")).toBeUndefined();
  });

  it("passes through normal multi-edit array unchanged", () => {
    const edits = [
      { oldText: "x", newText: "y" },
      { anchor: "fn f() {", oldText: "a", newText: "b" },
    ];
    const result = prepareEditArguments({
      path: "/tmp/x.txt",
      edits,
    }) as { path: string; edits: Array<{ oldText: string; newText: string }> };
    expect(result.edits).toEqual(edits);
  });

  it("repairs a single edit object sent without the array wrapper", () => {
    const result = prepareEditArguments({
      path: "/tmp/x.txt",
      edits: { oldText: "x", newText: "y" },
    }) as { path: string; edits: Array<{ oldText: string; newText: string }> };
    expect(result.edits).toEqual([{ oldText: "x", newText: "y" }]);
  });

  it("repairs a stringified single edit object", () => {
    const result = prepareEditArguments({
      path: "/tmp/x.txt",
      edits: JSON.stringify({ oldText: "x", newText: "y" }),
    }) as { path: string; edits: Array<{ oldText: string; newText: string }> };
    expect(result.edits).toEqual([{ oldText: "x", newText: "y" }]);
  });

  it("repairs an array whose entries are stringified edit objects", () => {
    const result = prepareEditArguments({
      path: "/tmp/x.txt",
      edits: [JSON.stringify({ oldText: "x", newText: "y" })],
    }) as { path: string; edits: Array<{ oldText: string; newText: string }> };
    expect(result.edits).toEqual([{ oldText: "x", newText: "y" }]);
  });

  it("throws an actionable error for a malformed edits string", () => {
    expect(() =>
      prepareEditArguments({
        path: "/tmp/x.txt",
        edits: "[{oldText: x",
      }),
    ).toThrow(/edits must be a JSON array of objects/);
  });

  it("throws an actionable error for a malformed stringified entry", () => {
    expect(() =>
      prepareEditArguments({
        path: "/tmp/x.txt",
        edits: ["not json"],
      }),
    ).toThrow(/edits must be a JSON array of objects/);
  });
});
