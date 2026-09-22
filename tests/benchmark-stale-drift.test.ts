/**
 * Regression tests from the pi-edit-benchmark "Failed runs" section
 * (contender pi-edit-guard 0.1.4). Fixture values are verbatim copies —
 * see tests/integration/fixtures/benchmark/scenarios.ts for sources.
 *
 * Contract under test (end-to-end through executeFile, the same pipeline
 * the edit tool runs): an edit whose search text no longer matches the
 * current file BYTES must fail WITHOUT modifying the file. External drift
 * (another tool, a formatter, a concurrent writer) is never silently
 * overwritten or grafted onto.
 *
 * The stale-line single-token case is pinned with it.fails: content alone
 * cannot tell a drifted `bbb-external` from a legitimate sub-line target
 * (sub-line-token depends on the same single-line substring match 4/6
 * models), so that case is owned by the stale-read hook (mtime signal),
 * covered in tests/stale-read-hook.test.ts.
 */
import { describe, it, expect } from "vitest";
import { executeFile } from "../src/edit/pipeline/execute.js";
import {
  b10DuplicateDrift,
  b9BoundaryChanged,
  crlfBom,
  emptyFile,
  formatterDrift,
  formatterDriftExpected,
  insertRaceStaleBoundary,
  staleLine,
  type BenchmarkScenario,
} from "./integration/fixtures/benchmark/scenarios.js";

interface RunOutcome {
  isError: boolean;
  written: string;
}

/** Run one agent edit against the DRIFTED bytes with an in-memory fs. */
async function runAgainstDrifted(scenario: BenchmarkScenario): Promise<RunOutcome> {
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

describe("benchmark stale-drift fixtures — drift must never be overwritten", () => {
  it("b10-duplicate-drift: rejects the edit, keeps `// drifted`", async () => {
    const { isError, written } = await runAgainstDrifted(b10DuplicateDrift);
    expect(isError).toBe(true);
    expect(written).toBe(b10DuplicateDrift.drifted);
  });

  it("insert-race-stale-boundary: rejects the insert, keeps `bbb-x`", async () => {
    const { isError, written } = await runAgainstDrifted(insertRaceStaleBoundary);
    expect(isError).toBe(true);
    expect(written).toBe(insertRaceStaleBoundary.drifted);
  });

  it("b9-boundary-changed: rejects the anchored edit, keeps `bbb-x`", async () => {
    const { isError, written } = await runAgainstDrifted(b9BoundaryChanged);
    expect(isError).toBe(true);
    expect(written).toBe(b9BoundaryChanged.drifted);
  });

  it.fails("stale-line: single-token substring graft is hook territory", async () => {
    // Content-only matching cannot distinguish drifted `bbb-external` from
    // a legitimate sub-line target — the stale-read hook owns this case.
    const { isError, written } = await runAgainstDrifted(staleLine);
    expect(isError).toBe(true);
    expect(written).toBe(staleLine.drifted);
  });

  it("empty-file: seeds a genuinely empty file", async () => {
    const { isError, written } = await runAgainstDrifted(emptyFile);
    expect(isError).toBe(false);
    expect(written).toBe("first\nsecond");
  });

  it("formatter-drift guard: tolerant apply preserves the reformat", async () => {
    const { isError, written } = await runAgainstDrifted(formatterDrift);
    expect(isError).toBe(false);
    expect(written).toBe(formatterDriftExpected);
  });

  it("crlf-bom guard: literal apply preserves BOM and CRLF", async () => {
    const { isError, written } = await runAgainstDrifted(crlfBom);
    expect(isError).toBe(false);
    expect(written).toBe("\uFEFFalpha\r\nBETA\r\ngamma\r\n");
  });
});
