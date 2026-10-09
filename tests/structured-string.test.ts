/**
 * Parity characterization for upstream pi PR #9569
 * ("coerce JSON-encoded object and array tool arguments").
 *
 * A verbatim-logic port of the PR (`parseStructuredString` + union
 * short-circuit + optional-null normalization of decoded structures) was
 * prototyped as a decode pass in `repairSchemaInput` and then reverted:
 * every case below already repairs identically on the unmodified pipeline
 * (verified A/B against stashed `src/`, including `oneOf`-via-Unsafe,
 * double-nested strings, records, and tuples). Our validate-then-repair
 * loop subsumes the PR — strict-error-site parsing covers what their
 * coerce-during-validation covers, and pass re-collection gives the
 * optional-null parity their second commit adds.
 *
 * These tests lock that parity in: if upstream ever merges #9569, or a
 * future schema stops emitting typed strict errors at stringified sites,
 * they fail and tell us exactly which behavior regressed.
 */

import { describe, it, expect } from "vitest";
import type { TSchema } from "typebox";
import { Type } from "typebox";
import { repairSchemaInput } from "../src/repair/repair-engine.js";

function repair(toolName: string, schema: TSchema, input: unknown) {
  return repairSchemaInput({ toolName, schema, input });
}

describe("structured-string decode (upstream pi#9569 prototype)", () => {
  it("coerces a JSON-encoded string into the array or object its schema asks for", () => {
    const cases: Array<{ schema: TSchema; input: unknown; expected: unknown }> = [
      {
        schema: Type.Object({ value: Type.Array(Type.String()) }),
        input: { value: '["a","b"]' },
        expected: { value: ["a", "b"] },
      },
      {
        schema: Type.Object({ value: Type.Array(Type.Number()) }),
        input: { value: '["1","2"]' },
        expected: { value: [1, 2] },
      },
      {
        schema: Type.Object({
          target: Type.Object({ name: Type.String(), count: Type.Number() }),
        }),
        input: { target: '{"name":"a","count":"2"}' },
        expected: { target: { name: "a", count: 2 } },
      },
      {
        schema: Type.Object({
          target: Type.Union([
            Type.Object({ kind: Type.Literal("a") }),
            Type.Object({ kind: Type.Literal("b") }),
          ]),
        }),
        input: { target: '{"kind":"b"}' },
        expected: { target: { kind: "b" } },
      },
    ];

    for (const testCase of cases) {
      const result = repair("echo", testCase.schema, testCase.input);
      expect(result.outcome, JSON.stringify(testCase.input)).toBe("repaired");
      expect(result.args).toEqual(testCase.expected);
    }
  });

  it("keeps a JSON-looking string when the schema also accepts a string", () => {
    const schema = Type.Object({
      value: Type.Union([Type.String(), Type.Object({ a: Type.Number() })]),
    });
    const input = { value: '{"a":1}' };

    const result = repair("echo", schema, input);
    expect(result.outcome).toBe("valid");
    expect(result.args).toBe(input);
  });

  it("leaves a value alone when the string is not the JSON type the schema asks for", () => {
    const failing: Array<{ schema: TSchema; input: unknown }> = [
      {
        schema: Type.Object({ value: Type.Object({}) }),
        input: { value: "not json" },
      },
      {
        schema: Type.Object({ value: Type.Object({}) }),
        input: { value: "[1,2]" },
      },
    ];

    for (const testCase of failing) {
      const result = repair("echo", testCase.schema, testCase.input);
      expect(result.outcome, JSON.stringify(testCase.input)).toBe("unrepairable");
      expect(result.retryMessage).toBeDefined();
    }
  });

  it("does not mis-decode a JSON object string meant for an array field", () => {
    // The decode layer must leave '{"a":1}' alone for an array field (it is
    // not an array); the pre-existing bare-string wrap rule then recovers it
    // as a single-element array with a teaching note.
    const result = repair("echo", Type.Object({ value: Type.Array(Type.String()) }), {
      value: '{"a":1}',
    });
    expect(result.outcome).toBe("repaired");
    expect(result.args).toEqual({ value: ['{"a":1}'] });
    expect(result.rulesFired).toContain("wrapBareStringAsArray");
    expect(result.rulesFired).not.toContain("parseJsonStringifiedObject");
  });

  it("decodes nested TypeBox array/object fields without Convert wrapping them", () => {
    const schema = Type.Object({
      tags: Type.Array(Type.String()),
      target: Type.Object({ name: Type.String(), count: Type.Number() }),
    });
    const result = repair("echo", schema, {
      tags: '["a","b"]',
      target: '{"name":"x","count":"2"}',
    });

    expect(result.outcome).toBe("repaired");
    expect(result.args).toEqual({ tags: ["a", "b"], target: { name: "x", count: 2 } });
  });

  it("normalizes optional nulls in a JSON-encoded structure like in a native one", () => {
    const schema = Type.Object({
      value: Type.Object({
        enabled: Type.Optional(Type.Boolean()),
        count: Type.Optional(Type.Number()),
        metadata: Type.Optional(Type.Object({ name: Type.String() })),
        nullable: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
      }),
      items: Type.Array(Type.Object({ enabled: Type.Optional(Type.Boolean()) })),
    });
    const expected = { value: { nullable: null }, items: [{}] };
    const native = {
      value: { enabled: null, count: null, metadata: null, nullable: null },
      items: [{ enabled: null }],
    };
    const encoded = {
      value: '{"enabled":null,"count":null,"metadata":null,"nullable":null}',
      items: '[{"enabled":null}]',
    };

    const nativeResult = repair("echo", schema, native);
    const encodedResult = repair("echo", schema, encoded);
    expect(nativeResult.args).toEqual(expected);
    expect(encodedResult.args).toEqual(expected);
  });

  it("never mutates the caller's input", () => {
    const schema = Type.Object({ value: Type.Array(Type.String()) });
    const input = { value: '["a","b"]' };
    repair("echo", schema, input);
    expect(input).toEqual({ value: '["a","b"]' });
  });
});
