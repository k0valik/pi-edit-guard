import { describe, it, expect } from "vitest";
import { resolveBlocks } from "../src/edit/pipeline/resolve.js";
import { findMatchStrongerThan } from "../src/edit/matching/chain.js";
import type { EditError } from "../src/edit/model.js";

const CONTENT = [
  "line 1",
  "def helper():",
  "    return 1",
  "",
  "def target():",
  "    return 2",
  "",
  "def helper():",
  "    return 3",
  "",
  "def target():",
  "    return 4",
].join("\n");

describe("resolveBlocks anchor window (Stage 1.4)", () => {
  it("resolves oldText within the anchor window (±10 lines)", () => {
    const outcome = resolveBlocks(
      CONTENT,
      [
        {
          path: "f.py",
          oldText: "def helper():",
          newText: "def helper2():",
          anchor: "return 4",
        },
      ],
      "f.py",
    );
    expect(outcome.ok).toBe(true);
    // Anchor "return 4" is unique; window covers the SECOND helper() only
    const resolved = outcome.resolved![0]!;
    const before = CONTENT.slice(0, resolved.start);
    expect(before.split("\n").length).toBeGreaterThan(7); // matched past line 7
  });

  it("anchor disambiguates a file-level-ambiguous oldText", () => {
    // Same block duplicated 20 lines apart; the anchor window covers only one.
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    lines[5] = "def dup():";
    lines[25] = "def dup():";
    const tall = lines.join("\n");

    const outcome = resolveBlocks(
      tall,
      [
        {
          path: "f.py",
          oldText: "def dup():",
          newText: "def renamed():",
          anchor: "line 24",
        },
      ],
      "f.py",
    );
    expect(outcome.ok).toBe(true);
    const resolved = outcome.resolved![0]!;
    const startLine = tall.slice(0, resolved.start).split("\n").length; // 1-indexed
    expect(startLine).toBe(26); // the SECOND dup (line 25 0-indexed → line 26 1-indexed), not the first
  });

  it("anchor window makes a far-away duplicate invisible", () => {
    // content with the same block 30 lines apart
    const wide = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
    const wideContent = wide.replace("line 5", "MARKER").replace("line 35", "MARKER");
    const outcome = resolveBlocks(
      wideContent,
      [
        {
          path: "w.txt",
          oldText: "MARKER",
          newText: "X",
          anchor: "line 6", // unique (no "line 6x" lines in 1..40)
        },
      ],
      "w.txt",
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.resolved![0]!.start).toBeLessThan(200); // near the top, not line 35
  });

  it("out-of-window UNIQUE target is rescued by full-content retry (P5)", () => {
    // Mined live (2026-08): anchors identify, they do not scope. When the
    // window misses but oldText is unambiguous at full scope, applying beats
    // aborting — uniqueness guards still run.
    const outcome = resolveBlocks(
      CONTENT,
      [
        {
          path: "f.py",
          oldText: "return 4",
          newText: "return 40",
          anchor: "line 1",
        },
      ],
      "f.py",
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.diagnostics[0]?.anchorWindowOverflow).toBe(true);
  });

  it("window miss + multi-occurrence target stays ambiguous (fail-closed)", () => {
    // Both "def helper():" occurrences lie OUTSIDE the anchor window, so the
    // windowed search misses; full-content retry must refuse to choose
    // between them instead of silently applying to the first.
    const content = [
      "line 1",
      ...Array.from({ length: 12 }, (_, i) => `// pad ${i}`),
      "def helper():",
      "    return 1",
      "// gap",
      "def helper():",
      "    return 2",
    ].join("\n");
    const outcome = resolveBlocks(
      content,
      [
        {
          path: "f.py",
          oldText: "def helper():",
          newText: "def helper2():",
          anchor: "line 1",
        },
      ],
      "f.py",
    );
    expect(outcome.ok).toBe(false);
    expect((outcome.errors[0] as EditError).kind).toBe("ambiguous");
  });

  it("anchor not found → anchor-not-found error", () => {
    const outcome = resolveBlocks(
      CONTENT,
      [
        {
          path: "f.py",
          oldText: "def target():",
          newText: "X",
          anchor: "no such text",
        },
      ],
      "f.py",
    );
    expect(outcome.ok).toBe(false);
    const error = outcome.errors[0] as EditError;
    expect(error.kind).toBe("anchor-not-found");
    expect(error.message).toContain("anchor");
  });

  it("ambiguous anchor → anchor-ambiguous error asking for a distinctive anchor", () => {
    const outcome = resolveBlocks(
      CONTENT,
      [
        {
          path: "f.py",
          oldText: "return 4",
          newText: "X",
          anchor: "def helper():",
        },
      ],
      "f.py",
    );
    expect(outcome.ok).toBe(false);
    const error = outcome.errors[0] as EditError;
    expect(error.kind).toBe("anchor-ambiguous");
    expect(error.linePositions).toHaveLength(2);
  });

  it("locates the anchor with the fuzzy chain (whitespace drift)", () => {
    const drifted = CONTENT.replace("def target():", "def  target():");
    const outcome = resolveBlocks(
      drifted,
      [
        {
          path: "f.py",
          oldText: "def  target():",
          newText: "def target2():",
          anchor: "return 4",
        },
      ],
      "f.py",
    );
    expect(outcome.ok).toBe(true);
  });

  it("replacement applies to verbatim matched text only (safety invariant)", () => {
    const outcome = resolveBlocks(
      CONTENT,
      [
        {
          path: "f.py",
          oldText: "return 2",
          newText: "return 20",
          anchor: "return 2",
        },
      ],
      "f.py",
    );
    expect(outcome.ok).toBe(true);
    const resolved = outcome.resolved![0]!;
    expect(CONTENT.slice(resolved.start, resolved.end)).toBe("return 2");
  });

  it("anchor is optional: no anchor means full-file search (unchanged behavior)", () => {
    const outcome = resolveBlocks(
      CONTENT,
      [{ path: "f.py", oldText: "line 1", newText: "line 1!" }],
      "f.py",
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.resolved![0]!.start).toBe(0);
  });

  it("weak window hit does not shadow a unique exact full-file match (issue #2)", () => {
    // Anchor sits >10 lines from a verbatim-unique target. The windowed
    // search previously accepted a token_overlap candidate inside the window
    // (wrong function, invalid syntax) instead of the exact match outside it.
    const content = [
      "async function prerequisiteIntegrationBlocker() {",
      "    for (const dependency of dependencies) {",
      "        if (!integrated) {",
      "            return `task is not integrated`;",
      "        }",
      "    }",
      "",
      "    return undefined;",
      "}",
      "",
      "/** Keep a task-bound blocker while its definition and Git inputs are unchanged. */",
      "async function blockedTaskStillBound(",
      "    workspace: Workspace,",
      "    task: TaskContract,",
      "    blocked: BlockedTaskBinding,",
      "): Promise<boolean> {",
      "    if (blocked.task !== task.id) {",
      "        return false;",
      "    }",
      "",
      "    const write = workspace.repositories.find((repo) =>",
      "        repo.repo === task.writeRepo",
      "    );",
      "",
      "    if (!write) {",
      "        return false;",
      "    }",
      "",
      "    const reads = task.readRepos.map((repoName) =>",
      "        workspace.repositories.find((repo) => repo.repo === repoName)",
      "    );",
      "",
      "    if (reads.some((repo) => repo === undefined)) {",
      "        return false;",
      "    }",
      "",
      "    try {",
      "        const [candidate] = await currentCandidates(workspace, task);",
      "        return candidate !== undefined;",
      "    } catch {",
      "        return true;",
      "    }",
      "}",
    ].join("\n");
    const oldText = "    } catch {\n        return true;\n    }\n}";
    const outcome = resolveBlocks(
      content,
      [
        {
          path: "repro.ts",
          oldText,
          newText: "    } catch {\n        return false;\n    }\n}",
          anchor: "async function blockedTaskStillBound(",
        },
      ],
      "repro.ts",
    );
    expect(outcome.ok).toBe(true);
    const resolved = outcome.resolved![0]!;
    expect(resolved.match.passName).toBe("simple");
    expect(resolved.match.actual).toBe(oldText);
    // Lands inside blockedTaskStillBound, not prerequisiteIntegrationBlocker.
    expect(content.slice(0, resolved.start)).toContain("blockedTaskStillBound");
    expect(outcome.diagnostics[0]?.anchorWindowOverflow).toBe(true);
  });

  it("window-prefix fuzzy hit does not truncate a multiline exact target (issue #2)", () => {
    // The anchor window holds only a prefix of the 11-line verbatim-unique
    // target. token_overlap previously accepted the prefix, leaving the
    // final line behind as invalid remnants (duplicated statement).
    const content = [
      "class Store:",
      "    def _state_bytes(self, index: bytes, aggregate_bytes: int) -> bytes:",
      '        return encode({"response_count": len(self._entries), "aggregate_bytes": aggregate_bytes})',
      "",
      "    def _publish_generation(self, entries, aggregate_bytes):",
      "        index = self._index_bytes(entries)",
      "        # Build state against the prospective entry set without mutating the",
      "        # active generation. This makes every generation self-contained.",
      "        old_entries, old_aggregate = self._entries, self._aggregate_bytes",
      "        self._entries = dict(entries)",
      "        self._aggregate_bytes = aggregate_bytes",
      "        try:",
      "            state = self._state_bytes(index, aggregate_bytes)",
      "        finally:",
      "            self._entries = old_entries",
      "            self._aggregate_bytes = old_aggregate",
      "        generation = make_generation()",
    ].join("\n");
    const oldText = [
      "        # Build state against the prospective entry set without mutating the",
      "        # active generation. This makes every generation self-contained.",
      "        old_entries, old_aggregate = self._entries, self._aggregate_bytes",
      "        self._entries = dict(entries)",
      "        self._aggregate_bytes = aggregate_bytes",
      "        try:",
      "            state = self._state_bytes(index, aggregate_bytes)",
      "        finally:",
      "            self._entries = old_entries",
      "            self._aggregate_bytes = old_aggregate",
      "        generation = make_generation()",
    ].join("\n");
    const outcome = resolveBlocks(
      content,
      [
        {
          path: "repro.py",
          oldText,
          newText:
            "        state = self._state_bytes(index, aggregate_bytes, len(entries))\n" +
            "        generation = make_generation()",
          anchor: "    def _publish_generation(self, entries, aggregate_bytes):",
        },
      ],
      "repro.py",
    );
    expect(outcome.ok).toBe(true);
    const resolved = outcome.resolved![0]!;
    expect(resolved.match.passName).toBe("simple");
    expect(resolved.match.actual).toBe(oldText);
  });

  it("ambiguous full-file stronger match keeps the window hit", () => {
    // The shadow guard must not steal anchor disambiguation: when the
    // stronger full-file hit is itself ambiguous, the in-window match stands.
    // oldText "  MARKER" matches verbatim twice far away (ambiguous simple)
    // while the window holds only an unindented MARKER (line_trimmed hit).
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    lines[10] = "MARKER";
    lines[30] = "  MARKER";
    lines[45] = "  MARKER";
    const wide = lines.join("\n");
    const outcome = resolveBlocks(
      wide,
      [{ path: "w.txt", oldText: "  MARKER", newText: "X", anchor: "line 12" }],
      "w.txt",
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.resolved![0]!.match.passName).toBe("line_trimmed");
    expect(outcome.diagnostics[0]?.anchorWindowOverflow).toBeUndefined();
  });
});

describe("findMatchStrongerThan", () => {
  const content = "alpha\nbeta\ngamma\ndelta";
  it("finds a stronger hit ahead of a weak pass", () => {
    const hit = findMatchStrongerThan(content, "beta", "token_overlap");
    expect(hit?.passName).toBe("simple");
    expect(hit?.actual).toBe("beta");
  });
  it("returns null when nothing stronger can fire", () => {
    expect(findMatchStrongerThan(content, "no such text", "token_overlap")).toBeNull();
  });
  it("returns null for the strongest pass and unknown names", () => {
    expect(findMatchStrongerThan(content, "beta", "simple")).toBeNull();
    expect(findMatchStrongerThan(content, "beta", "no_such_pass")).toBeNull();
  });
});
