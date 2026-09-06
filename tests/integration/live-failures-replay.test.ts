import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { executeFile } from "../../src/edit/pipeline/execute.js";
import { EDIT_SCHEMA, prepareEditArguments, repairLifecycle } from "../../src/repair/entry.js";
import { Value } from "typebox/value";
import type { Static } from "typebox";

// End-to-end replay of sanitized in-the-wild failures extracted by
// scripts/extract-live-failures.mjs from real pi sessions.
//
// These fixtures were recorded as FAILURES against the native tool. The
// assertion contract is inverted from session-failures.json: here we require
// the repair pipeline to turn each recorded failure into a successful apply
// (argument repairs), or into a precise diagnostic (already-applied).

const FIXTURES_PATH = join(process.cwd(), "tests", "integration", "fixtures", "live-failures.json");

interface LiveFixture {
  name: string;
  category: string;
  path?: string;
  edits: Array<{
    oldText?: string;
    newText?: string;
    anchor?: string;
    path?: string;
  }>;
  rawEditsString?: string;
  fileContent?: string;
  fileContentSynthetic?: boolean;
  expectedFailureText: string;
  source: { session: string; callLine: number };
}

function loadFixtures(): LiveFixture[] {
  return JSON.parse(readFileSync(FIXTURES_PATH, "utf-8"));
}

/** Rebuild the arguments exactly as the model originally sent them. */
function rawArgsFor(f: LiveFixture): Record<string, unknown> {
  if (f.category === "validation-nested-path") {
    // No root path — that is the whole failure mode.
    return { edits: f.edits.map((e) => ({ ...e })) };
  }
  if (f.category === "validation-edits-string") {
    return { path: f.path, edits: f.rawEditsString };
  }
  return {
    path: f.path,
    edits: f.edits.map(({ path: _nested, ...clean }) => clean),
  };
}

class InMemoryFS {
  private files = new Map<string, Buffer>();
  writeFile(p: string, c: string | Buffer) {
    this.files.set(p, typeof c === "string" ? Buffer.from(c, "utf-8") : c);
  }
  readFile(p: string): Buffer {
    const buf = this.files.get(p);
    if (!buf) throw new Error("ENOENT: " + p);
    return buf;
  }
  exists(p: string): boolean {
    return this.files.has(p);
  }
  access(p: string) {
    if (!this.files.has(p)) throw new Error("EACCES: " + p);
  }
  rename(from: string, to: string) {
    const buf = this.files.get(from);
    if (!buf) throw new Error("ENOENT: " + from);
    this.files.set(to, buf);
    this.files.delete(from);
  }
  mkdir(_p: string) {}
  unlink(p: string) {
    this.files.delete(p);
  }
}

async function runPrepared(
  preparedPath: string,
  preparedEdits: Array<{ oldText: string; newText: string; anchor?: string }>,
  fileContent: string,
): Promise<{ isError: boolean; text: string }> {
  const fs = new InMemoryFS();
  const absolute = isAbsolute(preparedPath) ? preparedPath : "/repo/" + preparedPath;
  fs.writeFile(absolute, fileContent);
  try {
    const result = await executeFile(absolute, preparedEdits, {
      cwd: "/repo",
      readFile: (p) => fs.readFile(p),
      writeFile: (p, c) => fs.writeFile(p, c),
      rename: (from, to) => fs.rename(from, to),
      exists: (p) => fs.exists(p),
      mkdir: (p) => fs.mkdir(p),
      unlink: (p) => fs.unlink(p),
    });
    return {
      isError: result.isError,
      text: result.content.map((c) => c.text || "").join("\n"),
    };
  } catch (err) {
    return { isError: true, text: err instanceof Error ? err.message : String(err) };
  }
}

describe("live failures — repair pipeline turns recorded errors into applies", () => {
  const fixtures = loadFixtures();

  it("has fixtures for every expected category", () => {
    const categories = new Set(fixtures.map((f) => f.category));
    expect(categories.has("validation-nested-path")).toBe(true);
    expect(categories.has("validation-edits-string")).toBe(true);
    expect(categories.has("already-applied-noop")).toBe(true);
    expect(categories.has("anchor-window-miss")).toBe(true);
    expect(categories.has("insertion-missing-oldtext")).toBe(true);
    expect(categories.has("chimera-recall-drift")).toBe(true);
    expect(categories.has("already-applied-misfire")).toBe(true);
  });

  // Chimera recall (mined 2026-08-16 storm, edit-engine.test.ts): the
  // model's oldText conflated TWO sibling tests — real title/comment lines
  // from the adjacent-context test, hallucinated scaffolding
  // (join(sandbox,...), writeFile) from its neighbor. Five retries with
  // five different anchors all failed on the old 9-pass chain. The current
  // block_anchor pass resolves via the REAL anchor line absorbing the
  // drifted middle. Guard: must keep applying, never degrade to not-found.
  it("applies chimera-recall drift via block_anchor (65-76% drifted oldText)", async () => {
    const f = fixtures.find((x) => x.name === "chimera-recall-edit-engine-dup-lines")!;
    const raw = rawArgsFor(f);
    expect(Value.Check(EDIT_SCHEMA, raw)).toBe(true); // schema-valid shape; failure was match-level
    const prepared = prepareEditArguments(raw) as Static<typeof EDIT_SCHEMA>;
    expect(Value.Check(EDIT_SCHEMA, prepared)).toBe(true);
    const { isError, text } = await runPrepared(
      f.path ?? "",
      prepared.edits as any,
      f.fileContent ?? "",
    );
    expect(isError).toBe(false);
    expect(text).toContain("Patched");
    expect(prepared.edits[0]!.anchor).toBeTruthy();
  });

  // Insertion attempts (stepfun, 2026-08): { anchor, newText } with no
  // oldText. When newText embeds the anchor verbatim, the preprocessor
  // derives oldText = anchor and the edit applies; otherwise the model gets
  // a targeted insertion hint instead of generic schema noise.
  for (const f of fixtures.filter((x) => x.category === "insertion-missing-oldtext")) {
    const entry = f.edits[0]!;
    const repairable =
      typeof entry.anchor === "string" &&
      entry.anchor.length > 0 &&
      typeof entry.newText === "string" &&
      entry.newText.includes(entry.anchor);
    // newText === anchor means the model's "insertion" was a true no-op;
    // the derived edit must report that precisely instead of schema noise.
    const pureNoop = repairable && entry.newText === entry.anchor;

    it(`${f.name}: ${!repairable ? "fails with an insertion hint" : pureNoop ? "reports the derived no-op precisely" : "infers oldText from anchor and applies"}`, async () => {
      repairLifecycle.clear();
      const raw = rawArgsFor(f);
      expect(Value.Check(EDIT_SCHEMA, raw)).toBe(false);

      if (!repairable) {
        expect(() => prepareEditArguments(raw)).toThrow(/no `oldText`[\s\S]*INSERT/);
        return;
      }

      const prepared = prepareEditArguments(raw) as {
        path: string;
        edits: Array<{ oldText: string; newText: string }>;
      };
      expect(prepared.edits[0]!.oldText).toBe(entry.anchor);
      expect(Value.Check(EDIT_SCHEMA, prepared)).toBe(true);
      const outcome = await runPrepared(prepared.path, prepared.edits, f.fileContent!);
      if (pureNoop) {
        expect(outcome.isError).toBe(true);
        expect(outcome.text).toMatch(/identical|no change/);
      } else {
        expect(outcome.isError, outcome.text).toBe(false);
      }
    });
  }

  for (const f of fixtures.filter((x) => x.category === "validation-nested-path")) {
    it(`${f.name}: hoists nested path and applies`, async () => {
      repairLifecycle.clear();
      const raw = rawArgsFor(f);

      // The raw shape must fail strict schema — reproducing the wild error.
      expect(Value.Check(EDIT_SCHEMA, raw)).toBe(false);

      const prepared = prepareEditArguments(raw) as {
        path: string;
        edits: Array<{ oldText: string; newText: string }>;
      };

      expect(typeof prepared.path).toBe("string");
      expect(prepared.path.length).toBeGreaterThan(0);
      for (const edit of prepared.edits) expect("path" in edit).toBe(false);
      expect(Value.Check(EDIT_SCHEMA, prepared)).toBe(true);

      const outcome = await runPrepared(prepared.path, prepared.edits, f.fileContent!);
      expect(outcome.isError, outcome.text).toBe(false);
    });
  }

  for (const f of fixtures.filter((x) => x.category === "validation-edits-string")) {
    it(`${f.name}: lenient-parses malformed JSON-string edits and applies`, async () => {
      repairLifecycle.clear();
      const raw = rawArgsFor(f);
      expect(Value.Check(EDIT_SCHEMA, raw)).toBe(false);

      const prepared = prepareEditArguments(raw) as {
        path: string;
        edits: Array<{ oldText: string; newText: string }>;
      };
      expect(Array.isArray(prepared.edits)).toBe(true);
      expect(prepared.edits.length).toBeGreaterThan(0);
      expect(Value.Check(EDIT_SCHEMA, prepared)).toBe(true);

      const outcome = await runPrepared(prepared.path, prepared.edits, f.fileContent!);
      expect(outcome.isError, outcome.text).toBe(false);
    });
  }

  it("already-applied case reports precise diagnostics instead of a noop confusion", async () => {
    const f = fixtures.find((x) => x.category === "already-applied-noop")!;
    repairLifecycle.clear();
    const raw = rawArgsFor(f);
    // Valid schema — passes straight through preparation.
    expect(Value.Check(EDIT_SCHEMA, raw)).toBe(true);
    const prepared = prepareEditArguments(raw) as {
      path: string;
      edits: Array<{ oldText: string; newText: string }>;
    };

    const outcome = await runPrepared(prepared.path, prepared.edits, f.fileContent!);
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("already applied");
    expect(outcome.text).not.toContain("no change");
  });

  // ---------------------------------------------------------------------------
  // already-applied MISFIRE corpus (deepseek-v4-flash/v4-pro session,
  // 2026-08-25): the model transformed repeated `down → project` navigation
  // blocks across several test sites. Valid-but-distant anchors (>±10 lines
  // from the target) made the windowed search miss, while REPLACE text
  // existed naturally in another test — the old guard answered "already
  // applied" and poisoned the model twice (both models believed it and went
  // verifying). Current contract:
  //   - distant-anchor misses degrade to full-content matching (7f4cc7d):
  //     unique → apply; multiple occurrences → honest ambiguity with lines.
  //   - "already present/applied" may NEVER appear: none of these edits was
  //     actually applied at the targeted sites (ground-truthed against the
  //     session's read snapshots).
  // ---------------------------------------------------------------------------
  const MISFIRES_EXPECT_APPLY = new Set([
    // Region B ("// Second session: project", ~L1453 anchor vs ~L1469 target)
    // has exactly ONE untransformed site per windowed snapshot → unique hit.
    "deepseek-newtool-session-173-538ff6-b1",
    // Long-context oldText is verbatim-unique at ~L565 despite the anchor at
    // ~L548 being 17 lines away.
    "deepseek-newtool-session-181-0cd4d6",
    "deepseek-newtool-session-188-72df83-b1",
  ]);

  for (const f of fixtures.filter((x) => x.category === "already-applied-misfire")) {
    const shouldApply = MISFIRES_EXPECT_APPLY.has(f.name);
    it(`${f.name}: ${shouldApply ? "distant anchor degrades to full-content match and applies" : "reports honest ambiguity instead of 'already applied'"}`, async () => {
      repairLifecycle.clear();
      const raw = rawArgsFor(f);
      expect(Value.Check(EDIT_SCHEMA, raw)).toBe(true);
      const prepared = prepareEditArguments(raw) as Static<typeof EDIT_SCHEMA>;
      expect(Value.Check(EDIT_SCHEMA, prepared)).toBe(true);

      const outcome = await runPrepared(f.path ?? "", prepared.edits as any, f.fileContent ?? "");

      // The regression pin: no misfire diagnosis may ever surface for these.
      expect(outcome.text).not.toMatch(/already (applied|present)/);

      if (shouldApply) {
        expect(outcome.isError, outcome.text).toBe(false);
        expect(outcome.text).toContain("Patched");
      } else {
        expect(outcome.isError, outcome.text).toBe(true);
        // Honest ambiguity names the occurrence count so the model can add
        // context or replaceAll — exactly what v4-pro ended up doing.
        expect(outcome.text).toMatch(/times|unique|replaceAll/);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Old-era corpus (native-tool sessions, 2026-04..2026-06), extracted by
// scripts/extract-old-era-fixtures.mjs. These prove what the pipeline does
// with failures that predate it: fuzzy recovery of drifted SEARCH text,
// salvage of multi-edit calls, deletion inference, placeholder cleanup, and
// precise diagnostics where nothing can be repaired.
// ---------------------------------------------------------------------------

describe("old-era wild failures — proof by replay", () => {
  const fixtures = loadFixtures();

  it("covers every old-era category", () => {
    const categories = new Set(fixtures.map((f) => f.category));
    // NOTE: oldera-empty-placeholder is intentionally absent — every
    // `[{} + real edit]` call in the corpus lost its snapshot (the real edit's
    // target text never appears in a prior read), so there is nothing
    // replayable to prove. The repair itself is covered by unit tests in
    // wild-repairs.test.ts.
    for (const cat of [
      "oldera-drifted-recovered",
      "oldera-multi-recovered",
      "oldera-boundary-drift",
      "oldera-gone-diagnostic",
      "oldera-ambiguous-diagnostic",
      "oldera-deletion-validation",
    ]) {
      expect(categories.has(cat), `missing category ${cat}`).toBe(true);
    }
  });

  for (const f of fixtures.filter(
    (x) =>
      x.category === "oldera-drifted-recovered" ||
      x.category === "oldera-multi-recovered" ||
      x.category === "oldera-boundary-drift" ||
      x.category === "anchor-window-miss",
  )) {
    // KNOWN PERF HOTSPOT: a heavily-drifted multi-hundred-char SEARCH against
    // even a small file can cost seconds in resolveBlocks (closest-candidate
    // + auto-expand). Wild content must not trip the default 5s timeout.
    it(`${f.name}: fuzzy chain recovers drifted SEARCH and applies`, async () => {
      repairLifecycle.clear();
      const raw = rawArgsFor(f);
      expect(Value.Check(EDIT_SCHEMA, raw)).toBe(true);
      const prepared = prepareEditArguments(raw) as {
        path: string;
        edits: Array<{ oldText: string; newText: string }>;
      };
      const outcome = await runPrepared(prepared.path, prepared.edits, f.fileContent!);
      expect(outcome.isError, outcome.text).toBe(false);
    }, 30_000);
  }

  for (const f of fixtures.filter((x) => x.category === "oldera-gone-diagnostic")) {
    it(`${f.name}: unrecoverable content yields closest-candidate diagnostic`, async () => {
      repairLifecycle.clear();
      const raw = rawArgsFor(f);
      const prepared = prepareEditArguments(raw) as {
        path: string;
        edits: Array<{ oldText: string; newText: string }>;
      };
      const outcome = await runPrepared(prepared.path, prepared.edits, f.fileContent!);
      expect(outcome.isError).toBe(true);
      expect(/Closest match|could not be applied/i.test(outcome.text), outcome.text).toBe(true);
    });
  }

  for (const f of fixtures.filter((x) => x.category === "oldera-ambiguous-diagnostic")) {
    it(`${f.name}: ambiguous match reports occurrences instead of failing blindly`, async () => {
      repairLifecycle.clear();
      const raw = rawArgsFor(f);
      const prepared = prepareEditArguments(raw) as {
        path: string;
        edits: Array<{ oldText: string; newText: string }>;
      };
      const outcome = await runPrepared(prepared.path, prepared.edits, f.fileContent!);
      expect(outcome.isError).toBe(true);
      expect(/times|unique|replaceAll/i.test(outcome.text), outcome.text).toBe(true);
    });
  }

  for (const f of fixtures.filter((x) => x.category === "oldera-deletion-validation")) {
    it(`${f.name}: oldText-only edit infers deletion and applies`, async () => {
      repairLifecycle.clear();
      const raw = rawArgsFor(f);
      expect(Value.Check(EDIT_SCHEMA, raw)).toBe(false);

      const prepared = prepareEditArguments(raw) as {
        path: string;
        edits: Array<{ oldText: string; newText: string }>;
      };
      expect(prepared.edits.length).toBeGreaterThan(0);
      const firstOldOnly = prepared.edits.find((e) => e.oldText.length > 0);
      expect(firstOldOnly!.newText).toBe("");
      expect(Value.Check(EDIT_SCHEMA, prepared)).toBe(true);

      const outcome = await runPrepared(prepared.path, prepared.edits, f.fileContent!);
      expect(outcome.isError, outcome.text).toBe(false);
    });
  }

  for (const f of fixtures.filter((x) => x.category === "oldera-empty-placeholder")) {
    it(`${f.name}: drops {} placeholder and applies the surviving edit`, async () => {
      repairLifecycle.clear();
      const raw = rawArgsFor(f);
      expect(Value.Check(EDIT_SCHEMA, raw)).toBe(false);

      const prepared = prepareEditArguments(raw) as {
        path: string;
        edits: Array<Record<string, unknown>>;
      };
      expect(prepared.edits.length).toBeGreaterThan(0);
      for (const edit of prepared.edits) {
        expect(Object.keys(edit).length, JSON.stringify(edit)).toBeGreaterThan(0);
      }
      expect(Value.Check(EDIT_SCHEMA, prepared)).toBe(true);

      const outcome = await runPrepared(
        prepared.path,
        prepared.edits as Array<{ oldText: string; newText: string }>,
        f.fileContent!,
      );
      expect(outcome.isError, outcome.text).toBe(false);
    });
  }
});
