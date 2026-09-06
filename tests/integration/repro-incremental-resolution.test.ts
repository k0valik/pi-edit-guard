import { describe, it, expect } from "vitest";
import { resolveBlocks } from "../../src/edit/pipeline/resolve.js";

describe("repro: incremental re-resolution", () => {
  it("re-resolves missing edits against post-Pass1 content", () => {
    // Edit A creates "PREFIX" which didn't exist in the original.
    // Edit B tries to replace "PREFIX" — fails in Pass 1, succeeds in Pass 2.
    const content = "AAA\nBBB\n";
    const blocks = [
      { path: "test.txt", oldText: "AAA", newText: "PREFIX" },
      { path: "test.txt", oldText: "PREFIX", newText: "SUFFIX" },
    ];
    const result = resolveBlocks(content, blocks, "test.txt");
    expect(result.resolved.length).toBe(2);
    expect(result.resolved[0]!.edit.newText).toBe("PREFIX");
    expect(result.resolved[1]!.edit.newText).toBe("SUFFIX");
    // The second edit's diagnostic should show it was recovered in Pass 2.
    const secondDiag = result.diagnostics.find((d) => d.index === 1);
    expect(secondDiag).toBeDefined();
    expect(secondDiag!.status).toBe("applied");
  });

  it("does not re-resolve edits that failed for non-missing reasons", () => {
    const content = "AAA\nBBB\n";
    // Both edits are no-ops (identical old/new text).
    const blocks = [
      { path: "test.txt", oldText: "AAA", newText: "AAA" },
      { path: "test.txt", oldText: "BBB", newText: "BBB" },
    ];
    const result = resolveBlocks(content, blocks, "test.txt");
    expect(result.resolved.length).toBe(0);
    expect(result.errors.every((e) => e.kind === "validation")).toBe(true);
  });

  it("re-resolves shift-induced misses when prior edit inserts content", () => {
    // Edit A inserts text before "BBB", shifting it.
    // Edit B targets "BBB" with extra context that was shifted.
    const content = "line1\nBBB\nline3\n";
    const blocks = [
      { path: "test.txt", oldText: "line1", newText: "INSERTED_LINE" },
      { path: "test.txt", oldText: "INSERTED_LINE\nBBB", newText: "INSERTED_LINE\nBBB\nline2\n" },
    ];
    const result = resolveBlocks(content, blocks, "test.txt");
    expect(result.resolved.length).toBe(2);
  });
});
