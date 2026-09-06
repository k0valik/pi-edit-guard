import { describe, it, expect } from "vitest";
import {
  ambiguousError,
  anchorNotFoundError,
  notFoundError,
  alreadyAppliedError,
  noOpError,
  validationError,
} from "../src/edit/errors.js";
import type { ClosestCandidate } from "../src/edit/model.js";

function candidate(overrides: Partial<ClosestCandidate> = {}): ClosestCandidate {
  return {
    passName: "closest-candidate",
    similarity: 0.7,
    candidate: "function hello() {\n  return 42;\n}",
    startLine: 52,
    endLine: 58,
    tokenDice: 0.69,
    tokenJaccard: 0.53,
    ...overrides,
  };
}

describe("TDD: error surface — issue #40", () => {
  it("notFound shows only similarity, not dice/jaccard", () => {
    const err = notFoundError("a.txt", candidate());
    expect(err.message).toContain("70% similar");
    expect(err.message).not.toContain("dice");
    expect(err.message).not.toContain("jaccard");
    // keeps helper
    expect(err.message).toContain("Closest match");
    expect(err.message).toContain("lines 52-58");
  });

  it("anchorNotFound shows only similarity, not dice/jaccard", () => {
    const err = anchorNotFoundError("a.txt", candidate());
    expect(err.message).toContain("70% similar");
    expect(err.message).not.toContain("dice");
    expect(err.message).not.toContain("jaccard");
  });

  it("ambiguous uses oldText, not SEARCH", () => {
    const err = ambiguousError("a.txt", 2, [10, 20]);
    expect(err.message).not.toContain("SEARCH");
    expect(err.message).toContain("oldText");
  });

  it("notFound base uses oldText, not SEARCH", () => {
    const err = notFoundError("a.txt", candidate());
    expect(err.message).not.toContain("SEARCH text not found");
    expect(err.message).toContain("oldText");
  });

  it("alreadyApplied uses oldText/newText, not SEARCH/REPLACE", () => {
    const err = alreadyAppliedError("a.txt", { count: 1, positions: [2] });
    expect(err.message).not.toContain("SEARCH");
    expect(err.message).not.toContain("REPLACE");
    expect(err.message).toContain("oldText");
    expect(err.message).toContain("newText");
    expect(err.message).toContain("line 2");
  });

  it("truncates closest candidate preview to ~200 chars", () => {
    const long = "x".repeat(5000);
    const err = notFoundError("a.txt", candidate({ candidate: long, similarity: 0.7 }));
    // preview is in message after "Closest match"
    const previewSection = err.message.split("Closest match")[1] ?? "";
    // should not contain the full 5000-char string
    expect(previewSection.length).toBeLessThan(600);
    // bounded to ~200 + overhead (8*80 would be 640, so must be smaller)
    expect(previewSection.length).toBeLessThan(400);
    // should indicate truncation
    expect(previewSection).toMatch(/…|truncated/i);
    // underlying long string must not be echoed verbatim
    expect(err.message).not.toContain(long);
  });

  it("validation empty and identical use oldText/newText", async () => {
    // These are produced in resolve.ts, but errors.ts helpers are the source of truth.
    // We assert the helpers themselves don't use SEARCH/REPLACE.
    // Editor messages are covered by integration, but we at least check noOp doesn't leak SEARCH.
    const noop = noOpError();
    expect(noop.message).not.toContain("SEARCH");
    expect(noop.message).not.toContain("REPLACE");
    // validationError is passthrough, just ensure it exists
    const v = validationError("edits[0]: oldText is empty");
    expect(v.message).toContain("oldText");
  });
});
