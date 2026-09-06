import { describe, it, expect } from "vitest";
import { applyEdits } from "../../src/edit/pipeline/apply.js";
import { findOccurrencePositions } from "../../src/edit/matching/chain.js";

describe("repro: overlap cascade + findOccurrencePositions", () => {
  it("applyEdits allows cascading overlaps where prior edit removes the target", () => {
    // Edit A replaces the full span; Edit B overlaps A in the original.
    // After A is applied, B's target is gone, so B should be "already-handled"
    // rather than rejected as "overlap".
    const content = "abc";
    const resolved = [
      {
        edit: { path: "test.txt", oldText: "abc", newText: "aY" },
        match: { actual: "abc", passName: "simple" },
        start: 0,
        end: 3,
      },
      {
        edit: { path: "test.txt", oldText: "bc", newText: "Z" },
        match: { actual: "bc", passName: "simple" },
        start: 1,
        end: 3,
      },
    ];
    const result = applyEdits(content, resolved);

    // Currently: second edit is flagged as "overlap" in the pre-check
    // and skipped entirely. After the fix it should be applied or
    // already-handled, but never "overlap".
    const overlapFailures = result.failed.filter((f) => f.kind === "overlap");
    expect(overlapFailures).toHaveLength(0);

    // The inner edit (higher start) is applied first bottom-up.
    const appliedTexts = result.applied.map((a) => a.edit.newText);
    expect(appliedTexts).toContain("Z");

    // The outer edit's span was consumed by the inner edit, so it is
    // reported as already-handled rather than applied.
    const alreadyHandled = result.failed.find((f) => f.kind === "already-handled");
    expect(alreadyHandled).toBeDefined();
    expect(alreadyHandled!.edit.newText).toBe("aY");
  });

  it("findOccurrencePositions does not report overlapping occurrences", () => {
    // "aa" occurs at index 0 and index 1 in "aaa", but those occurrences
    // overlap. Only the first should be reported.
    const positions = findOccurrencePositions("aaa", "aa");
    expect(positions).toEqual([1]);

    // Non-overlapping case: "aba" in "abaXaba" occurs at index 0 and index 4.
    const positions2 = findOccurrencePositions("abaXaba", "aba");
    expect(positions2).toEqual([1, 1]);
  });
});
