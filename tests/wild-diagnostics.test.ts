import { describe, it, expect } from "vitest";
import { resolveBlocks } from "../src/edit/pipeline/resolve.js";
import { buildAutoExpandWarnings, executeFile } from "../src/edit/pipeline/execute.js";
import type { EditError } from "../src/edit/model.js";

// In-the-wild regression coverage:
// - already-applied detection (step-3.7-flash: REPLACE text already present
//   after a partial retry was misreported as a generic no-op/not-found)
// - redundant-anchor drop (step-3.7-flash: anchor copied from oldText with a
//   hallucinated regex `/i` flag — anchor can never match, edit is fine)

const FILE = [
  "const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}$/;",
  "",
  "export function makeId(): string {",
  '  return "id-" + crypto.randomUUID();',
  "}",
].join("\n");

function firstError(result: { errors: EditError[] }): EditError {
  const error = result.errors[0];
  if (!error) throw new Error("expected an error");
  return error;
}

describe("already-applied detection", () => {
  it("reports already-applied when REPLACE text exists and SEARCH does not", () => {
    // Simulates a retried edit: the earlier attempt already rewrote desktop→cli.
    const content = '{\n  "enabled": true,\n  "client": "cli",\n  "stableSession": true\n}\n';
    const result = resolveBlocks(
      content,
      [
        {
          path: "example-config.json",
          oldText: '  "client": "desktop",',
          newText: '  "client": "cli",',
        },
      ],
      "example-config.json",
    );
    expect(result.ok).toBe(false);
    const error = firstError(result);
    expect(error.kind).toBe("already-applied");
    expect(error.message).toContain("already applied");
  });

  it("keeps plain not-found when REPLACE text is absent too", () => {
    const result = resolveBlocks(
      FILE,
      [{ path: FILE, oldText: "const A = 1;", newText: "const B = 2;" }],
      "file.ts",
    );
    expect(firstError(result).kind).toBe("not-found");
  });

  it("does not fire for trivially short REPLACE text", () => {
    // newText shorter than the guard threshold must not trigger the claim.
    const content = "value\n".repeat(10) + "}\n";
    const result = resolveBlocks(
      content,
      [{ path: "f.txt", oldText: "const missing = true;", newText: "}" }],
      "f.txt",
    );
    expect(firstError(result).kind).toBe("not-found");
  });

  it("does not fire when SEARCH still matches (normal edit path)", () => {
    const content = '{\n  "client": "desktop",\n}\n';
    const result = resolveBlocks(
      content,
      [
        {
          path: "c.json",
          oldText: '"client": "desktop"',
          newText: '"client": "cli", longer replacement text here',
        },
      ],
      "c.json",
    );
    expect(result.ok).toBe(true);
  });

  it("cites REPLACE occurrence lines so the claim is falsifiable evidence", () => {
    // Natural-occurrence misfire mined from deepseek-newtool-session
    // (2026-08-25): REPLACE text occurs naturally at an UNRELATED site; both
    // v4-flash and v4-pro believed the bare claim and spent turns verifying.
    // The message must expose its evidence so the model can falsify it.
    const content = ["alpha one", '  "client": "cli",', "gamma three"].join("\n");
    const result = resolveBlocks(
      content,
      [{ path: "c.json", oldText: '"client": "desktop"', newText: '  "client": "cli",' }],
      "c.json",
    );
    expect(result.ok).toBe(false);
    const error = firstError(result);
    expect(error.kind).toBe("already-applied");
    expect(error.message).toContain("line 2");
    // No skip commands on unverified claims.
    expect(error.message).not.toContain("instead of retrying");
  });

  it("lists every REPLACE occurrence line for multi-site presence", () => {
    const block = "const repeatedBoilerplateLine = configureRegistry(options); // stable";
    const content = ["head", block, "mid", "tail", block].join("\n");
    const result = resolveBlocks(
      content,
      [{ path: "f.ts", oldText: "const gone = true;", newText: block }],
      "f.ts",
    );
    const error = firstError(result);
    expect(error.kind).toBe("already-applied");
    expect(error.message).toContain("line 2");
    expect(error.message).toContain("line 5");
  });

  it("does not fire when REPLACE is contained in SEARCH (tail-line misfire)", () => {
    // Mined live 2026-09-09 (ui_integration.test.ts): oldText was a 2k-char
    // block ending in the throttle-test line; newText was JUST that 73-char
    // line, present once at line 470. Presence is expected pre-edit — the
    // line rides inside the assumed context — so it proves nothing about
    // application. Must fall through to honest not-found, not already-applied.
    const tailLine = '  it("throttles rendering correctly to avoid TUI flickers", async () => {';
    const oldText = ['  it("ghost test one", async () => {', "  });", tailLine].join("\n");
    expect(tailLine.length).toBeGreaterThanOrEqual(64); // STRONG range, like the wild shape
    const content = ["header line", tailLine, "trailing line"].join("\n");
    const result = resolveBlocks(content, [{ path: "f.ts", oldText, newText: tailLine }], "f.ts");
    expect(result.ok).toBe(false);
    expect(firstError(result).kind).toBe("not-found");
  });
});

describe("redundant-anchor drop", () => {
  const OLD_TEXT = [
    "const SESSION_ID_RE = /^ses_[0-9A-Za-z]{26}$/;",
    "const REQUEST_ID_RE = /^msg_[0-9A-Za-z]{26}$/;",
    "",
    'export const IDENTITY = { kind: "cli" };',
  ].join("\n");

  // Wild shape (stepfun): anchor byte-identical to oldText except a single
  // hallucinated regex flag — unfindable, yet nearly equal to oldText.
  const HALLUCINATED_ANCHOR = OLD_TEXT.replace("{26}$/;", "{26}$/i;");

  const CONTENT = ['import fs from "node:fs";', "", OLD_TEXT, "", "export default 1;"].join("\n");

  it("wild-exact shape: anchor identical to missing oldText degrades to not-found, not anchor-not-found", () => {
    const MISSING = [
      "const A_RE = /^a_[0-9A-Za-z]{26}$/;",
      "const B_RE = /^b_[0-9A-Za-z]{26}$/;",
    ].join("\n");
    const result = resolveBlocks(
      CONTENT,
      [{ path: "ids.ts", oldText: MISSING, newText: `${MISSING}\nconst C = 1;`, anchor: MISSING }],
      "ids.ts",
    );
    expect(result.ok).toBe(false);
    // The failure is about SEARCH text now — actionable closest-candidate
    // info — instead of the misleading anchor framing.
    expect(firstError(result).kind).toBe("not-found");
  });

  it("drops an unfindable anchor that nearly equals oldText (hallucinated flag)", () => {
    expect(HALLUCINATED_ANCHOR).not.toBe(OLD_TEXT);
    const result = resolveBlocks(
      CONTENT,
      [
        {
          path: "ids.ts",
          oldText: OLD_TEXT,
          newText: OLD_TEXT.replace("ses_", "ses3_"),
          anchor: HALLUCINATED_ANCHOR,
        },
      ],
      "ids.ts",
    );
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.diagnostics[0]?.anchorRedundant).toBe(true);
    expect(result.diagnostics[0]?.anchorFallback).toBeUndefined();
  });

  it("hallucinated anchor + verbatim-unique oldText applies via full retry (P5)", () => {
    // Mined live (2026-08, fingerprint.test.ts): the anchor exists only in
    // the model's imagination while oldText matches verbatim. Aborting
    // wasted a correct edit; unanchored matching with its uniqueness guards
    // is the deterministic salvage.
    const result = resolveBlocks(
      CONTENT,
      [
        {
          path: "ids.ts",
          oldText: OLD_TEXT,
          newText: OLD_TEXT.replace("ses_", "ses9_"),
          anchor: "totally different text\nthat appears nowhere at all",
        },
      ],
      "ids.ts",
    );
    expect(result.ok).toBe(true);
    expect(result.diagnostics[0]?.anchorFallback).toBe(true);
  });

  it("keeps anchor-not-found when oldText is ALSO absent from the file", () => {
    const result = resolveBlocks(
      CONTENT,
      [
        {
          path: "ids.ts",
          oldText: "const TOTALLY_ABSENT_RE = /nowhere/;",
          newText: "x",
          anchor: "totally different text\nthat appears nowhere at all",
        },
      ],
      "ids.ts",
    );
    expect(result.ok).toBe(false);
    const error = firstError(result);
    expect(error.kind).toBe("anchor-not-found");
  });

  it("still uses the window when the anchor matches normally", () => {
    const result = resolveBlocks(
      CONTENT,
      [
        {
          path: "ids.ts",
          oldText: OLD_TEXT,
          newText: OLD_TEXT.replace("ses_", "ses2_"),
          anchor: OLD_TEXT,
        },
      ],
      "ids.ts",
    );
    // Anchor present in file → normal windowed matching, no drop.
    expect(result.ok).toBe(true);
    expect(result.diagnostics[0]?.anchorRedundant).toBeUndefined();
    expect(result.diagnostics[0]?.match?.anchorUsed ?? false).toBe(true);
  });
});

describe("ambiguous auto-expand placement warning (P6)", () => {
  // Wild shape (2026-09-14, tests/compaction-trigger.test.ts): a 3-line test
  // ending matched N tests; auto-expand silently picked the wrong one and the
  // model burned turns on test fallout before noticing. The edit still
  // applies, but the result must say it was a guess drawn from N sites.
  const ENDING = [
    "    expect(runtime.compactInFlight).toBe(false);",
    "    expect(ctx.compact).not.toHaveBeenCalled();",
    "  });",
  ].join("\n");
  const FILLER = ["    handler(agentEnd(), ctx);", "    await flushAll();"].join("\n");
  const WILD_CONTENT = [
    '  it("the intended stale test", async () => {',
    FILLER,
    ENDING,
    "  });",
    "",
    '  it("unrelated threshold test", async () => {',
    FILLER,
    ENDING,
    "  });",
    "",
    '  it("unrelated threshold test", async () => {',
    FILLER,
    ENDING,
    "  });",
    "",
    '  it("trailing test after the ambiguous region", async () => {',
    "    expect(true).toBe(true);",
    "  });",
    "});",
  ].join("\n");

  it("records the confirmed occurrence count on auto-expand success", () => {
    const result = resolveBlocks(
      WILD_CONTENT,
      [{ path: "t.test.ts", oldText: ENDING, newText: `${ENDING}\n    // appended` }],
      "t.test.ts",
    );
    expect(result.ok).toBe(true);
    const diag = result.diagnostics[0];
    expect(diag?.match?.passName).toBe("auto_expand");
    expect(diag?.ambiguousMatchCount).toBe(3);
    expect(diag?.lineRange?.start).toBeGreaterThan(0);
  });

  it("builds a short warning naming count and line, echoing no content", () => {
    const result = resolveBlocks(
      WILD_CONTENT,
      [{ path: "t.test.ts", oldText: ENDING, newText: `${ENDING}\n    // appended` }],
      "t.test.ts",
    );
    const warnings = buildAutoExpandWarnings(result.diagnostics);
    expect(warnings).toHaveLength(1);
    const text = warnings[0]!;
    expect(text).toContain("[AMBIGUOUS PLACEMENT]");
    expect(text).toContain("matched 3 times");
    expect(text).toMatch(/lines? \d+/);
    expect(text.length).toBeLessThan(160);
    // No 50+ char content echo: neither the oldText lines nor filler appear.
    expect(text).not.toContain("compactInFlight");
    expect(text).not.toContain("agentEnd");
  });

  it("stays silent on unique matches (no auto-expand, no warning)", () => {
    const result = resolveBlocks(
      WILD_CONTENT,
      [
        {
          path: "t.test.ts",
          oldText: 'it("the intended stale test"',
          newText: 'it("renamed test"',
        },
      ],
      "t.test.ts",
    );
    expect(result.ok).toBe(true);
    expect(result.diagnostics[0]?.match?.passName).toBe("simple");
    expect(buildAutoExpandWarnings(result.diagnostics)).toEqual([]);
  });

  it("surfaces the warning end-to-end through executeFile", async () => {
    const files: Record<string, Buffer | string> = {
      "/tmp/wild-ambiguous.txt": Buffer.from(WILD_CONTENT, "utf-8"),
    };
    const result = await executeFile(
      "/tmp/wild-ambiguous.txt",
      [{ oldText: ENDING, newText: `${ENDING}\n    // appended` }],
      {
        readFile: (p) => files[p] as Buffer,
        writeFile: (p, data) => {
          files[p] = data;
        },
        rename: (from, to) => {
          files[to] = files[from] ?? Buffer.alloc(0);
        },
        exists: () => true,
      },
    );
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain("[AMBIGUOUS PLACEMENT]");
    expect(result.content[0]?.text).toContain("matched 3 times");
    expect((result.details as { placementWarnings?: string[] }).placementWarnings).toHaveLength(1);
  });
});

describe("identical-text noop names the anchor field (P7)", () => {
  // Wild shape (2026-09-14, CHANGELOG.md): the model sent oldText == newText
  // as a placeholder anchor for a second edit in the same call. The failure
  // must point at the anchor field instead of just saying "does nothing".
  it("points at the anchor field without echoing content", () => {
    const anchorLike =
      "### Fixed\n\n- **Surface silently skipped stale-ctx auto-compactions.**\n".repeat(4);
    const result = resolveBlocks(
      "CHANGELOG.md content here",
      [{ path: "CHANGELOG.md", oldText: anchorLike, newText: anchorLike }],
      "CHANGELOG.md",
    );
    expect(result.ok).toBe(false);
    const error = firstError(result);
    expect(error.message).toContain("anchor field");
    // No long content echo even though the anchor-like text is 200+ chars.
    expect(error.message).not.toContain("stale-ctx");
    const diag = result.diagnostics[0];
    expect(diag?.status).toBe("noop");
    expect(diag?.reason).toContain("anchor field");
  });

  it("keeps the legacy does-nothing/identical wording for existing matchers", () => {
    const result = resolveBlocks(
      "hello\n",
      [{ path: "f.txt", oldText: "hello", newText: "hello" }],
      "f.txt",
    );
    expect(firstError(result).message).toMatch(/does nothing|identical/i);
  });
});
