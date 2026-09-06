import { describe, it, expect } from "vitest";
import { resolveBlocks } from "../src/edit/pipeline/resolve.js";
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
