import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BRACE_BALANCE_ENABLED,
  coherenceCheck,
  findPrevNonEmptyLine,
} from "../../src/advisories/coherence.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(__dirname, "fixtures", "files");

const SKIP = !BRACE_BALANCE_ENABLED ? "(brace-balance checker temporarily disabled)" : undefined;

describe.skipIf(SKIP)("repro: brace-balance false positives", () => {
  it("does not warn on .txt fixture with regex + template-literal braces", () => {
    const content = readFileSync(join(fixtureDir, "27-brace-false-positives.txt"), "utf-8");
    const warnings = coherenceCheck(content, "27-brace-false-positives.txt");
    const hasBrace = warnings.some(
      (w) => w.includes("brace") || w.includes("paren") || w.includes("bracket"),
    );
    expect(hasBrace).toBe(false);
    console.log("txt fixture warnings:", warnings);
  });

  it("does not warn on regex content without path (density-based)", () => {
    const content = readFileSync(join(fixtureDir, "27-brace-false-positives.txt"), "utf-8");
    const warnings = coherenceCheck(content);
    const hasBrace = warnings.some(
      (w) => w.includes("brace") || w.includes("paren") || w.includes("bracket"),
    );
    expect(hasBrace).toBe(false);
    console.log("no-path warnings:", warnings);
  });

  it("does not warn on .sh files with brace expansion (extension-based)", () => {
    const content = `echo "{a,b,c}"
echo "{1..10}"
echo "{{{{"`;
    const warnings = coherenceCheck(content, "test.sh");
    const hasBrace = warnings.some(
      (w) => w.includes("brace") || w.includes("paren") || w.includes("bracket"),
    );
    expect(hasBrace).toBe(false);
    console.log("sh warnings:", warnings);
  });

  it("still warns on real unbalanced braces in code files", () => {
    const content = `function bad() {
  if (x) {
    return 1;
  }
  // missing closing brace`;
    const warnings = coherenceCheck(content, "test.ts");
    const hasBrace = warnings.some((w) => w.includes("Unclosed"));
    expect(hasBrace).toBe(true);
    console.log("real imbalance warnings:", warnings);
  });

  it("still warns on real excess closing braces in code files", () => {
    const content = `function bad() {
  if (x) {
    return 1;
  }}
}`;
    const warnings = coherenceCheck(content, "test.ts");
    const hasBrace = warnings.some((w) => w.includes("Too many closing"));
    expect(hasBrace).toBe(true);
    console.log("excess closing warnings:", warnings);
  });

  it("warns on unclosed template literals containing braces", () => {
    const content = "`hello { world";
    const warnings = coherenceCheck(content, "test.js");
    const hasBrace = warnings.some(
      (w) =>
        w.includes("Unclosed") ||
        w.includes("brace") ||
        w.includes("paren") ||
        w.includes("bracket"),
    );
    expect(hasBrace).toBe(true);
    console.log("unclosed template warnings:", warnings);
  });

  it("warns on unclosed regex literals containing braces", () => {
    const content = "const pattern = /foo{1,10"; // unclosed regex
    const warnings = coherenceCheck(content, "test.js");
    const hasBrace = warnings.some(
      (w) =>
        w.includes("Unclosed") ||
        w.includes("brace") ||
        w.includes("paren") ||
        w.includes("bracket"),
    );
    expect(hasBrace).toBe(true);
    console.log("unclosed regex warnings:", warnings);
  });

  it("does not falsely suppress warnings when / is a division operator", () => {
    const content = "const x = 1 / 2; { a: 1 } /foo/ (";
    const warnings = coherenceCheck(content, "test.ts");
    const hasUnclosed = warnings.some(
      (w) =>
        w.includes("Unclosed") ||
        w.includes("brace") ||
        w.includes("paren") ||
        w.includes("bracket"),
    );
    expect(hasUnclosed).toBe(true);
    console.log("division operator warnings:", warnings);
  });

  it("exports findPrevNonEmptyLine for backward compatibility", () => {
    expect(typeof findPrevNonEmptyLine).toBe("function");
    const lines = ["", "hello", "world"];
    expect(findPrevNonEmptyLine(lines, 2)).toBe(1);
  });

  it("does not toggle template state on escaped backticks", () => {
    const content = "`hello \\`world` { a: 1";
    const warnings = coherenceCheck(content, "test.js");
    const hasUnclosed = warnings.some(
      (w) =>
        w.includes("Unclosed") ||
        w.includes("brace") ||
        w.includes("paren") ||
        w.includes("bracket"),
    );
    expect(hasUnclosed).toBe(true);
    console.log("escaped backtick warnings:", warnings);
  });

  it("does not end regex on / inside a character class", () => {
    const content = "const x = /a[/]b/; { a: 1 } { a: 1 } { a: 1";
    const warnings = coherenceCheck(content, "test.ts");
    const hasUnclosed = warnings.some(
      (w) =>
        w.includes("Unclosed") ||
        w.includes("brace") ||
        w.includes("paren") ||
        w.includes("bracket"),
    );
    expect(hasUnclosed).toBe(true);
    console.log("character class warnings:", warnings);
  });
});
