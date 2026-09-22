/**
 * Verbatim scenario fixtures copied from the pi-edit-benchmark harness
 * (https://github.com/YuGiMob/pi-edit-benchmark, results/llm-report.md
 * "Failed runs" section for contender pi-edit-guard 0.1.4).
 *
 * Each entry captures the three states the harness drives:
 *   - fixture: file content the agent was shown by `read`
 *   - drifted:  file content after the harness's mutateAfterRead (what the
 *               agent's edit actually raced against on disk)
 *   - agentEdit: the exact tool arguments a benchmark model sent
 *                (copied from the linked trace JSON)
 *
 * Source refs name the benchmark file + scenario id + model trace the values
 * were copied from, so any entry can be re-validated against the upstream
 * repo checked out at /tmp/pi-edit-benchmark.
 */

export interface BenchmarkScenario {
  /** Benchmark scenario id. */
  id: string;
  /** File name used by the harness run. */
  fileName: string;
  /** Content served to the agent's `read` (before external mutation). */
  fixture: string;
  /** Content on disk when the agent's edit executes (after mutation). */
  drifted: string;
  /** Exact agent tool arguments from the cited trace (stale view). */
  agentEdit: {
    oldText: string;
    newText: string;
    anchor?: string;
    replaceAll?: boolean;
  };
  /** Trace the agentEdit was copied from. */
  traceRef: string;
}

/**
 * b10-duplicate-drift — two identical blocks; a line inside the SECOND block
 * drifted after read. The edit must be refused, not silently overwrite it.
 * Source: src/scenarios/better-edit.ts (b10-duplicate-drift),
 * trace: muse-spark-1.3-contributor/pi-edit-guard-b10-duplicate-drift.json m6.
 * Failed 6/6 models with outcome applied (silent-wrong-line).
 */
export const b10DuplicateDrift: BenchmarkScenario = {
  id: "b10-duplicate-drift",
  fileName: "b10.ts",
  fixture: "function a() {\n  return 1;\n}\nfunction b() {\n  return 2;\n}\n",
  drifted: "function a() {\n  return 1;\n}\nfunction b() {\n  return 2; // drifted\n}\n",
  agentEdit: { oldText: "  return 2;\n}", newText: "  return 2;\n};" },
  traceRef: "muse-spark-1.3-contributor/pi-edit-guard-b10-duplicate-drift.json",
};

/**
 * insert-race-stale-boundary — the anchor line for an insert changed
 * externally after read; the insert must be refused, not misplaced.
 * Source: src/scenarios/index.ts (insert-race-stale-boundary),
 * trace: muse-spark-1.3-contributor/pi-edit-guard-insert-race-stale-boundary.json m4.
 * Failed 6/6 models with outcome applied (silent-wrong-line).
 */
export const insertRaceStaleBoundary: BenchmarkScenario = {
  id: "insert-race-stale-boundary",
  fileName: "insert-race.ts",
  fixture: "aaa\nbbb\nccc\n",
  drifted: "aaa\nbbb-x\nccc\n",
  agentEdit: { oldText: "bbb\nccc", newText: "bbb\nBB1\nBB2\nccc" },
  traceRef: "muse-spark-1.3-contributor/pi-edit-guard-insert-race-stale-boundary.json",
};

/**
 * b9-boundary-changed — the exact anchor line changed on disk; the edit must
 * be refused as stale.
 * Source: src/scenarios/better-edit.ts (b9-boundary-changed),
 * trace: qwen3.8-flash/pi-edit-guard-b9-boundary-changed.json m4.
 * Failed 1/6 models (Qwen); the other 5 "recovered" only because the agent
 * re-read and cleaned up the grafted drift by hand (false pass — the drift
 * was still destroyed mid-run).
 */
export const b9BoundaryChanged: BenchmarkScenario = {
  id: "b9-boundary-changed",
  fileName: "b9.ts",
  fixture: "aaa\nbbb\nccc\n",
  drifted: "aaa\nbbb-x\nccc\n",
  agentEdit: { oldText: "aaa\nbbb", newText: "aaa\nBBB", anchor: "aaa" },
  traceRef: "qwen3.8-flash/pi-edit-guard-b9-boundary-changed.json",
};

/**
 * stale-line — the exact target line was modified externally; the edit must
 * be refused.
 * Source: src/scenarios/index.ts (stale-line),
 * trace: glm-5.3-flash/pi-edit-guard-stale-line.json m4.
 * Failed 1/6 models (GLM) outright; the other 5 show the same graft-then-
 * cleanup false-pass pattern as b9. Single-line token-substring matches
 * cannot be told apart from legitimate sub-line edits by content alone
 * (sub-line-token relies on them 4/6 models), so this case is owned by the
 * stale-read hook (mtime signal), not the match chain.
 */
export const staleLine: BenchmarkScenario = {
  id: "stale-line",
  fileName: "stale-line.ts",
  fixture: "aaa\nbbb\nccc\n",
  drifted: "aaa\nbbb-external\nccc\n",
  agentEdit: { oldText: "bbb", newText: "BBB" },
  traceRef: "glm-5.3-flash/pi-edit-guard-stale-line.json",
};

/**
 * empty-file — insert the first content into an empty file.
 * Source: src/scenarios/index.ts (empty-file),
 * trace: muse-spark-1.3-contributor/pi-edit-guard-empty-file.json m4.
 * Failed 6/6 models with outcome applied (noop): the agent sent empty
 * oldText, the tool hard-errored, the agent gave up. The benchmark excuses
 * builtin-edit and pi-semantic-edit (expected rejected) but not us.
 * Note: the trace's newText carries a trailing newline; the harness expects
 * exactly "first\nsecond", so the pinned edit below uses that form.
 */
export const emptyFile: BenchmarkScenario = {
  id: "empty-file",
  fileName: "empty.txt",
  fixture: "",
  drifted: "",
  agentEdit: { oldText: "", newText: "first\nsecond" },
  traceRef: "muse-spark-1.3-contributor/pi-edit-guard-empty-file.json",
};

/**
 * formatter-drift guard — a formatter reindented the file after read; the
 * target token survives. Tolerant tools apply onto current bytes.
 * Source: src/scenarios/index.ts (formatter-drift),
 * trace: qwen3.8-flash/pi-edit-guard-formatter-drift.json m4 (first edit —
 * the only correct one; the agent's follow-up edits un-formatted the file).
 * Passed 5/6 models; pinned here so drift-tolerant matching cannot regress.
 */
export const formatterDrift: BenchmarkScenario = {
  id: "formatter-drift",
  fileName: "formatter-drift.ts",
  fixture:
    [
      "function connect(opts) {",
      "  const host = opts.host;",
      "  const port = opts.port ?? 8080;",
      "  return { host, port };",
    ].join("\n") + "\n",
  drifted:
    [
      "function connect(opts) {",
      "    const host = opts.host;",
      "    const port = opts.port ?? 8080;",
      "    return { host, port };",
    ].join("\n") + "\n",
  agentEdit: {
    oldText: "  const port = opts.port ?? 8080;",
    newText: "  const port = opts.port ?? 9090;",
    anchor: "  const host = opts.host;",
  },
  traceRef: "qwen3.8-flash/pi-edit-guard-formatter-drift.json",
};

/** Harness-expected post-edit content for formatter-drift (drift preserved). */
export const formatterDriftExpected: string =
  [
    "function connect(opts) {",
    "    const host = opts.host;",
    "    const port = opts.port ?? 9090;",
    "    return { host, port };",
  ].join("\n") + "\n";

/**
 * crlf-bom guard — BOM-prefixed CRLF file; the agent's literal replacement
 * must apply with BOM and CRLF endings intact.
 * Source: src/scenarios/index.ts (crlf-bom).
 * Passed 5/6 models; the single failure (MiMo-Pro) was an agent typo
 * (newText "BETA.") the tool applied literally — correct behavior.
 * Pinned here so byte preservation cannot regress.
 */
export const crlfBom: BenchmarkScenario = {
  id: "crlf-bom",
  fileName: "crlf-bom.txt",
  fixture: "\uFEFFalpha\r\nbeta\r\ngamma\r\n",
  drifted: "\uFEFFalpha\r\nbeta\r\ngamma\r\n",
  agentEdit: { oldText: "beta", newText: "BETA" },
  traceRef: "mimo-v2.6-pro/pi-edit-guard-crlf-bom.json",
};
