/**
 * Second-wave benchmark regressions — pi-edit-benchmark llm-report
 * (2026-09-23, 10 models, contender pi-edit-guard 0.1.5).
 *
 * Each case pins the exact agent tool arguments from the cited trace
 * (copied to tests/integration/fixtures/benchmark/traces/) run against
 * the drifted bytes through executeFile. Cases that still fail are
 * marked it.fails with the mechanism in the message; fixed cases assert
 * the correct outcome.
 */
import { describe, it, expect } from "vitest";
import { executeFile } from "../src/edit/pipeline/execute.js";
import {
  b15LargeRangeDrift,
  b6TrailingNewline,
  crlfBomLfQuery,
  duplicateImportHallucinated,
  formatterDriftWriteback,
  whitespaceOnlyTrailing,
  type BenchmarkScenario,
} from "./integration/fixtures/benchmark/scenarios.js";

async function runAgainst(
  scenario: BenchmarkScenario,
): Promise<{ isError: boolean; written: string }> {
  const path = `/bench/${scenario.fileName}`;
  const store = new Map<string, Buffer>([[path, Buffer.from(scenario.drifted, "utf-8")]]);
  const result = await executeFile(
    path,
    [
      {
        oldText: scenario.agentEdit.oldText,
        newText: scenario.agentEdit.newText,
        anchor: scenario.agentEdit.anchor,
        replaceAll: scenario.agentEdit.replaceAll,
      },
    ],
    {
      cwd: "/bench",
      readFile: (p) => {
        const hit = store.get(p);
        if (hit === undefined) throw new Error(`unexpected read: ${p}`);
        return hit;
      },
      writeFile: (p, data) => {
        store.set(p, Buffer.isBuffer(data) ? data : Buffer.from(data, "utf-8"));
      },
      rename: (from, to) => {
        store.set(to, store.get(from)!);
        store.delete(from);
      },
      exists: () => true,
      mkdir: () => {},
      unlink: (p) => {
        store.delete(p);
      },
      stat: () => ({ mode: 0o644 }),
      chmod: () => {},
      lstat: () => ({ isSymbolicLink: () => false }),
      realpath: (p) => p,
    },
  );
  return { isError: result.isError, written: store.get(path)!.toString("utf-8") };
}

describe("benchmark second wave (llm-report 2026-09-23) — misplaced edits", () => {
  it.fails("b15-large-range-drift: stale 181-line range must be refused", async () => {
    // block_anchor family scores the drifted interior at ~0.999 and grafts.
    const { isError, written } = await runAgainst(b15LargeRangeDrift);
    expect(isError).toBe(true);
    expect(written).toBe(b15LargeRangeDrift.drifted);
  });

  it.fails("duplicate-import: hallucinated 4-line oldText must not duplicate", async () => {
    // context_aware trims the phantom 4th line onto the 3 real ones.
    const { isError, written } = await runAgainst(duplicateImportHallucinated);
    expect(isError).toBe(true);
    expect(written).toBe(duplicateImportHallucinated.drifted);
  });

  it("whitespace-only: full-line replace strips trailing spaces", async () => {
    // Whole-line trailing expansion in findMatch widens `bbb` to `bbb  `.
    const { written } = await runAgainst(whitespaceOnlyTrailing);
    expect(written).toBe("aaa\nBBB\nccc\n");
  });

  it("crlf-bom with LF-only query: CRLF ending survives", async () => {
    // LF-normalized match writes a bare \n back into a CRLF file.
    const { written } = await runAgainst(crlfBomLfQuery);
    expect(written).toBe("\uFEFFalpha\r\nBETA\r\ngamma\r\n");
  });

  it("b6-change-then-revert: trailing newline in newText adds no blank line", async () => {
    const { written } = await runAgainst(b6TrailingNewline);
    expect(written).toBe("aaa\nB\nD\n");
  });

  it("formatter-drift writeback: verbatim stale-indent block applies literally (model error, documented)", async () => {
    // The 2nd edit is a verbatim match whose newText reverts the reformat.
    // No content signal distinguishes it from intent; the tool applies it.
    const { isError, written } = await runAgainst(formatterDriftWriteback);
    expect(isError).toBe(false);
    expect(written).toBe(
      [
        "function connect(opts) {",
        "  const host = opts.host;",
        "  const port = opts.port ?? 9090;",
        "  return { host, port };",
      ].join("\n") + "\n",
    );
  });
});
