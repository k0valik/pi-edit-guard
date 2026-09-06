import { describe, it, expect } from "vitest";
import { resolveBlocks } from "../../src/edit/pipeline/resolve.js";

describe("debug partial apply 3", () => {
  it("show actual status by forcing failure", () => {
    const simpleContent = `// prefix\nAAA\n// suffix\n// prefix\nAAA\n// suffix\n`;
    const result = resolveBlocks(
      simpleContent,
      [
        { path: "test.txt", oldText: "AAA", newText: "L1" },
        { path: "test.txt", oldText: "ZZZ", newText: "LX" },
      ],
      "test.txt",
    );
    const status0 = result.diagnostics[0]?.status ?? "undefined";
    const status1 = result.diagnostics[1]?.status ?? "undefined";
    // Force failure to see actual values
    expect(status0 + "|" + status1).toBe("applied|missing");
  });
});
