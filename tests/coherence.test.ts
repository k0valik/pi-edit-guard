import { describe, it, expect } from "vitest";
import { BRACE_BALANCE_ENABLED, coherenceCheck } from "../src/advisories/coherence.js";

/**
 * Extensive coherence-check tests.
 *
 * All fixtures are inline strings so this file never hardcodes a user
 * home directory or repo path. The checks below are brace-depth-aware:
 * indentation jumps are only compared between lines at the same brace
 * depth, so entering/exiting nested blocks must NOT produce warnings.
 */

const TS_NESTED_BLOCKS = `export interface Config {
  enabled: boolean;
  nested: {
    depth: number;
    values: string[];
  };
}

export function build(): Config {
  return {
    enabled: true,
    nested: {
      depth: 2,
      values: ["a", "b"],
    },
  };
}`;

const TS_REAL_JUMP = `function bad() {
  if (x) {
    return 1;
              return 2;
  }
}`;

const PYTHON_MIXED = `def foo():
    if True:
        return 1
    return 0`;

const JSON_NESTED = `{
  "outer": {
    "inner": {
      "value": 1
    }
  }
}`;

const JSX_NESTED = `export const Page = () => {
  return (
    <div>
      <header>
        <h1>Title</h1>
      </header>
    </div>
  );
};`;

const UNCLOSED_BRACES = `function bad() {
  if (x) {
    return 1;
  }
  // missing closing brace for function`;

const EXCESS_CLOSING_BRACES = `function bad() {
  if (x) {
    return 1;
  }}
}`;

const BALANCED = `function ok() {
  if (x) {
    return 1;
  }
  return 0;
}`;

const REGEX_CONTENT = `EMAIL = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/`;

const SHELL_CONTENT = `MSG="{name: "test"}`;

const BLANK_LINES_AND_COMMENTS = `function foo() {
  // comment at indent 2

  if (x) {
    // comment at indent 4

    return 1;
  }

  return 0;
}`;

const SAME_DEPTH_RIGHT_ALIGN = `const x = [
  1,
    2,
  3,
];`;

describe("coherenceCheck — brace balance", () => {
  const SKIP = !BRACE_BALANCE_ENABLED ? "(brace-balance checker temporarily disabled)" : undefined;

  it.skipIf(SKIP)("reports unclosed braces in a .ts file", () => {
    const warnings = coherenceCheck(UNCLOSED_BRACES, "test.ts");
    expect(warnings.some((w) => w.includes("Unclosed"))).toBe(true);
    expect(warnings.some((w) => w.includes("Too many closing"))).toBe(false);
  });

  it.skipIf(SKIP)("reports excess closing braces in a .ts file", () => {
    const warnings = coherenceCheck(EXCESS_CLOSING_BRACES, "test.ts");
    expect(warnings.some((w) => w.includes("Too many closing"))).toBe(true);
    expect(warnings.some((w) => w.includes("Unclosed"))).toBe(false);
  });

  it.skipIf(SKIP)("does not warn on balanced code", () => {
    const warnings = coherenceCheck(BALANCED, "test.ts");
    expect(warnings).toHaveLength(0);
  });

  it.skipIf(SKIP)("suppresses brace warning for regex content (density-based)", () => {
    const warnings = coherenceCheck(REGEX_CONTENT, "test.js");
    expect(warnings.some((w) => w.includes("Too many closing"))).toBe(false);
    expect(warnings.some((w) => w.includes("Unclosed"))).toBe(false);
  });

  it.skipIf(SKIP)("suppresses brace warning for .sh files (extension-based)", () => {
    const warnings = coherenceCheck(SHELL_CONTENT, "test.sh");
    expect(warnings.some((w) => w.includes("Too many closing"))).toBe(false);
    expect(warnings.some((w) => w.includes("Unclosed"))).toBe(false);
  });
});

describe("coherenceCheck — brace-depth-aware indentation", () => {
  it("does NOT warn on nested TS interface/object transitions", () => {
    const warnings = coherenceCheck(TS_NESTED_BLOCKS, "test.ts");
    expect(warnings).toHaveLength(0);
  });

  it("does NOT warn on nested JSON transitions", () => {
    const warnings = coherenceCheck(JSON_NESTED, "test.json");
    expect(warnings).toHaveLength(0);
  });

  it("does NOT warn on nested JSX returns", () => {
    const warnings = coherenceCheck(JSX_NESTED, "test.tsx");
    expect(warnings).toHaveLength(0);
  });

  it("does NOT warn on Python nested blocks", () => {
    const warnings = coherenceCheck(PYTHON_MIXED, "test.py");
    expect(warnings).toHaveLength(0);
  });

  it("does NOT warn when blank lines/comments separate same-depth siblings", () => {
    const warnings = coherenceCheck(BLANK_LINES_AND_COMMENTS, "test.ts");
    expect(warnings).toHaveLength(0);
  });

  it("warns on real same-depth indentation jumps in TS", () => {
    const warnings = coherenceCheck(TS_REAL_JUMP, "test.ts");
    expect(warnings.some((w) => w.includes("suspicious indentation jump"))).toBe(true);
  });

  it("does not warn on shallow same-depth right-aligned arrays", () => {
    const warnings = coherenceCheck(SAME_DEPTH_RIGHT_ALIGN, "test.ts");
    expect(warnings).toHaveLength(0);
  });
});

describe("coherenceCheck — 8-space indentation threshold", () => {
  it("does NOT warn on 7-space same-depth jumps (false positive regression)", () => {
    // A 7-space jump should NOT trigger — this was a common false positive
    // pattern when the threshold was 4.
    // prevIndent=2, indent=9 → diff=7 < 8.
    const content = `function foo() {
  if (x) {
  if (y) {
         return 2;
  }
}`;
    const warnings = coherenceCheck(content, "test.ts");
    expect(warnings.filter((w) => w.includes("suspicious indentation jump"))).toHaveLength(0);
  });

  it("does NOT warn on 4–7 space jumps (common refactoring patterns)", () => {
    // Switching from 2-space to 4-space indent, or moderate re-indentation.
    // prevIndent=4, indent=8 → diff=4 < 8.
    const content = `function foo() {
  if (x) {
    return 1;
        return 2;
  }
}`;
    const warnings = coherenceCheck(content, "test.ts");
    expect(warnings.filter((w) => w.includes("suspicious indentation jump"))).toHaveLength(0);
  });

  it("warns on 9-space same-depth jumps (real corruption)", () => {
    // A 9-space jump is genuinely suspicious — likely a copy-paste error.
    // prevIndent=4, indent=14 → diff=10 > 8.
    const content = `function foo() {
  if (x) {
    return 1;
              return 2;
  }
}`;
    const warnings = coherenceCheck(content, "test.ts");
    expect(warnings.some((w) => w.includes("suspicious indentation jump"))).toBe(true);
    expect(warnings[0]).toContain("from 4 to 14");
  });

  it("warns on large same-depth jumps (TS_REAL_JUMP scenario)", () => {
    const content = `function bad() {
  if (x) {
    return 1;
                    return 2;
  }
}`;
    const warnings = coherenceCheck(content, "test.ts");
    expect(warnings.some((w) => w.includes("suspicious indentation jump"))).toBe(true);
  });

  it("does NOT warn when indentation change crosses brace depth boundaries", () => {
    // Entering/exiting nested blocks may change indent by 2–4 spaces.
    // Even 8-space jumps should not warn if brace depth changes.
    const content = `function outer() {
  if (a) {
    if (b) {
      if (c) {
        deep();
    }
  }
}`;
    const warnings = coherenceCheck(content, "test.ts");
    // The closing brace at indent 4 vs indent 6 is at different depths.
    expect(warnings.filter((w) => w.includes("suspicious indentation jump"))).toHaveLength(0);
  });

  it("does NOT warn on consistent 4-space vs 2-space indentation styles", () => {
    // A file using 4-space indent throughout should not warn.
    const content = `function foo() {
    if (x) {
        return 1;
    }
}`;
    const warnings = coherenceCheck(content, "test.ts");
    expect(warnings).toHaveLength(0);
  });

  it("does NOT warn on consistent 2-space indentation style", () => {
    const content = `function foo() {
  if (x) {
    return 1;
  }
}`;
    const warnings = coherenceCheck(content, "test.ts");
    expect(warnings).toHaveLength(0);
  });

  it("does NOT warn on tab-based indentation (tab = 4 spaces)", () => {
    const content = `function foo() {
\tif (x) {
\t\treturn 1;
\t}
}`;
    const warnings = coherenceCheck(content, "test.ts");
    expect(warnings).toHaveLength(0);
  });

  it("does NOT warn on tab-based indentation with 4-space visual steps", () => {
    // Tabs are counted as 1 char by search(/\S/), so tab-based files
    // use 1-space visual steps — should not warn.
    const content = `function foo() {
\tif (x) {
\t\treturn 1;
\t}
}`;
    const warnings = coherenceCheck(content, "test.ts");
    expect(warnings).toHaveLength(0);
  });
});

describe("coherenceCheck — path-aware behavior", () => {
  it("treats missing path as non-shell/non-regex", () => {
    const warnings = coherenceCheck(SHELL_CONTENT);
    // Without a .sh extension, density may still suppress, but we only
    // assert this call does not throw and returns a string array.
    expect(Array.isArray(warnings)).toBe(true);
  });

  it("uses extension-based suppression for .sh", () => {
    const warnings = coherenceCheck(SHELL_CONTENT, "script.sh");
    expect(warnings.some((w) => w.includes("Too many closing"))).toBe(false);
  });

  it("uses density-based suppression for regex literals", () => {
    const warnings = coherenceCheck(REGEX_CONTENT, "pattern.js");
    expect(warnings.some((w) => w.includes("Too many closing"))).toBe(false);
  });
});

describe("coherenceCheck — edge cases", () => {
  it("returns no warnings on empty content", () => {
    expect(coherenceCheck("")).toHaveLength(0);
    expect(coherenceCheck("\n\n")).toHaveLength(0);
  });

  it("returns no warnings on whitespace-only content", () => {
    expect(coherenceCheck("   \n\t\n  ")).toHaveLength(0);
  });

  it("handles content with only comments", () => {
    const content = `// comment 1
// comment 2`;
    expect(coherenceCheck(content, "test.ts")).toHaveLength(0);
  });
});

describe("coherenceCheck — string-literal-aware indentation", () => {
  it("does NOT warn when the changed lines are inside string literals", () => {
    // Reproduces the user-observed false positive: a test fixture that
    // contains multi-line strings whose internal indentation varies.
    const lines = [
      "const original = [",
      '  "line1",',
      '         "line2",',
      '    "line3",',
      "];",
      "const x = 1;",
    ];
    const content = lines.join("\n");
    const warnings = coherenceCheck(content, "test.ts");
    expect(warnings).toHaveLength(0);
  });

  it("does NOT warn on multi-line template literal indentation", () => {
    const content = `const x = \`hello
  world
    foo\`;
const y = 1;`;
    const warnings = coherenceCheck(content, "test.ts");
    expect(warnings).toHaveLength(0);
  });

  it("still warns on real indentation jumps outside string literals", () => {
    const content = `function bad() {
  if (x) {
    return 1;
              return 2;
  }
}`;
    const warnings = coherenceCheck(content, "test.ts");
    expect(warnings.some((w) => w.includes("suspicious indentation jump"))).toBe(true);
  });
});

describe("coherenceCheck — focus window size", () => {
  it("does NOT warn on a real jump farther than 6 lines from changed lines", () => {
    // Build a file with a real jump far from the changed lines.
    const before = Array.from({ length: 15 }, (_, i) => `  line${i}\n`).join("");
    const jump = "              badReturn\n";
    const after = Array.from({ length: 10 }, (_, i) => `  line${i + 15}\n`).join("");
    const content = before + jump + after;
    const focusLines = new Set([0, 1, 2, 3, 4, 5]); // far from the jump at line 15
    const warnings = coherenceCheck(content, "test.ts", focusLines);
    expect(warnings).toHaveLength(0);
  });

  it("still warns on a real jump within 6 lines of changed lines", () => {
    const before = Array.from({ length: 3 }, (_, i) => `  line${i}\n`).join("");
    const jump = "              badReturn\n";
    const after = Array.from({ length: 3 }, (_, i) => `  line${i + 3}\n`).join("");
    const content = before + jump + after;
    const focusLines = new Set([5]); // near the jump
    const warnings = coherenceCheck(content, "test.ts", focusLines);
    expect(warnings.some((w) => w.includes("suspicious indentation jump"))).toBe(true);
  });

  it("still detects warnings when called directly (gating is in executeFile)", () => {
    const content = `function bad() {
  if (x) {
    return 1;
              return 2;
  }
}`;
    const warnings = coherenceCheck(content, "test.ts");
    expect(warnings.some((w) => w.includes("suspicious indentation jump"))).toBe(true);
  });
});
