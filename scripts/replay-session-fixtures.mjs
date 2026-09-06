#!/usr/bin/env node
/**
 * Replay extracted session fixtures END-TO-END against both the builtin edit
 * tool and our full pipeline (registerEditTool: argument repair -> match
 * chain -> apply -> error surfacing), producing a comparison report.
 *
 * Unlike the builtin side, our side goes through the exact same entry point
 * the model's tool call hits in production — so argument repairs, stale-read
 * guards and enriched diagnostics are all part of what gets measured.
 *
 * Usage:
 *   pnpm exec jiti scripts/replay-session-fixtures.mjs
 *
 * Must run through jiti: the src/ tree uses TS-style ".js" specifiers that
 * plain Node's type stripping does not resolve.
 *
 * Outputs replay-report.json (path overridable via REPLAY_REPORT env).
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { readFile as fsReadFile, writeFile as fsWriteFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createEditToolDefinition } from "@earendil-works/pi-coding-agent";
import { createPiMock, makeCtx } from "../packages/pi-base/src/pi-mock.js";
import { registerEditTool } from "../src/platform/tools/edit.js";

// ===========================================================================
// Config
// ===========================================================================

const SESSION_FIXTURES = join(
  process.cwd(),
  "tests",
  "integration",
  "fixtures",
  "session-failures.json",
);
const REPORT_OUTPUT =
  process.env.REPLAY_REPORT ??
  join(process.cwd(), "tests", "integration", "fixtures", "replay-report.json");

// ===========================================================================
// Tool setup — one builtin definition, one fully-wired extension instance
// ===========================================================================

const realOps = {
  readFile: (p) => fsReadFile(p),
  writeFile: (p, content) => fsWriteFile(p, content),
  access: (p) => access(p),
};

const pi = createPiMock();
registerEditTool(pi);

function ourTool() {
  return pi.tools[0];
}

// ===========================================================================
// Replay helpers
// ===========================================================================

function extractErrorSignature(text) {
  if (text.includes("W_ROBUST_EDIT_FALLBACK")) return "W_ROBUST_EDIT_FALLBACK";
  if (text.includes('Validation failed for tool "edit"')) return "Validation failed";
  if (text.includes("Could not find")) return "not-found";
  if (text.includes("overlap in")) return "overlap";
  if (text.includes("occurrences")) return "ambiguous";
  if (text.includes("No changes made")) return "noop";
  if (text.includes("oldText must not be empty")) return "validation";
  if (text.includes("Patch failed")) return "patch-failed";
  return "unknown";
}

async function timedExecute(run) {
  const t0 = performance.now();
  const result = await run();
  return { ms: performance.now() - t0, result };
}

async function replayWithBuiltinTool(fileContent, edits, absolutePath, cwd) {
  const tool = createEditToolDefinition(cwd, { operations: realOps });
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, fileContent, "utf-8");

  try {
    const { ms, result } = await timedExecute(() =>
      tool.execute("replay-tool-call", { path: absolutePath, edits }, undefined, undefined, {
        cwd,
      }),
    );
    const text = result.content.map((c) => c.text || "").join("\n");
    return { isError: !!result.isError, text, signature: result.isError ? extractErrorSignature(text) : "success", ms };
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    return { isError: true, text, signature: extractErrorSignature(text), ms: 0 };
  }
}

async function replayWithOurTool(fileContent, rawArgs, absolutePath, cwd) {
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, fileContent, "utf-8");

  // Production order: pi runs prepareArguments before execute.
  const tool = ourTool();
  const prepared =
    typeof tool.prepareArguments === "function" ? tool.prepareArguments(rawArgs) : rawArgs;

  try {
    const { ms, result } = await timedExecute(() =>
      tool.execute(
        `replay-${randomUUID().slice(0, 8)}`,
        prepared,
        undefined,
        undefined,
        makeCtx({ cwd }),
      ),
    );
    const text = result.content.map((c) => c.text || "").join("\n");
    return {
      isError: !!result.isError,
      text,
      signature: result.isError ? extractErrorSignature(text) : "success",
      ms,
    };
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    return { isError: true, text, signature: extractErrorSignature(text), ms: 0 };
  }
}

// ===========================================================================
// Timing stats
// ===========================================================================

function timingStats(samples) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return {
    meanMs: Number(mean.toFixed(2)),
    medianMs: Number(pct(0.5).toFixed(2)),
    p95Ms: Number(pct(0.95).toFixed(2)),
  };
}

// ===========================================================================
// Main
// ===========================================================================

async function main() {
  console.log("Loading fixtures...");
  const fixtures = JSON.parse(readFileSync(SESSION_FIXTURES, "utf-8"));
  console.log(`Loaded ${fixtures.length} fixtures`);

  const report = [];
  let baselineErrors = 0;
  let ourErrors = 0;
  let improved = 0;
  let regressed = 0;
  let expectationMismatches = 0;
  const baselineTimings = [];
  const ourTimings = [];

  for (const fixture of fixtures) {
    const runId = randomUUID().slice(0, 8);
    const tempDir = join(tmpdir(), `replay-${runId}`);
    mkdirSync(tempDir, { recursive: true });

    const absolutePath = join(tempDir, fixture.path);
    const cwd = tempDir;

    console.log(`\n[${fixture.name}] ${fixture.path} (${fixture.edits.length} edits)`);

    // Baseline: native tool, well-formed arguments.
    const baselineResult = await replayWithBuiltinTool(
      fixture.fileContent,
      fixture.edits,
      absolutePath,
      cwd,
    );
    console.log(`  builtin:   ${baselineResult.signature} (${baselineResult.ms.toFixed(1)}ms)`);

    // Ours: full pipeline through the registered tool entry point.
    const ourResult = await replayWithOurTool(
      fixture.fileContent,
      { path: absolutePath, edits: fixture.edits },
      absolutePath,
      cwd,
    );
    console.log(`  our tool:  ${ourResult.signature} (${ourResult.ms.toFixed(1)}ms)`);

    if (baselineResult.isError) baselineErrors++;
    if (ourResult.isError) ourErrors++;
    if (baselineResult.isError && !ourResult.isError) improved++;
    if (!baselineResult.isError && ourResult.isError) regressed++;
    baselineTimings.push(baselineResult.ms);
    ourTimings.push(ourResult.ms);

    // Expectation check: does our outcome match what the fixture documents?
    const expected = fixture.expected ?? {};
    const matchesExpected =
      ourResult.isError === Boolean(expected.isError) &&
      (!expected.mustContain || ourResult.text.includes(expected.mustContain));
    if (!matchesExpected) {
      expectationMismatches++;
      console.log(`  EXPECTATION MISMATCH (expected isError=${expected.isError})`);
    }

    report.push({
      name: fixture.name,
      category: fixture.category,
      path: fixture.path,
      editCount: fixture.edits.length,
      expected: fixture.expected,
      baseline: {
        isError: baselineResult.isError,
        signature: baselineResult.signature,
        durationMs: Number(baselineResult.ms.toFixed(2)),
        text: baselineResult.text.slice(0, 200),
        matchesExpected:
          baselineResult.isError &&
          Boolean(expected.mustContain) &&
          baselineResult.text.includes(expected.mustContain ?? ""),
      },
      ourTool: {
        isError: ourResult.isError,
        signature: ourResult.signature,
        durationMs: Number(ourResult.ms.toFixed(2)),
        text: ourResult.text.slice(0, 200),
      },
      matchesExpected,
      improved: baselineResult.isError && !ourResult.isError,
      regressed: !baselineResult.isError && ourResult.isError,
      source: fixture.source,
    });

    rmSync(tempDir, { recursive: true, force: true });
  }

  // Summary
  console.log("\n=== Summary ===");
  console.log(`Total fixtures:        ${fixtures.length}`);
  console.log(`Baseline errors:       ${baselineErrors}`);
  console.log(`Our tool errors:       ${ourErrors}`);
  console.log(`Improved (we fixed):   ${improved}`);
  console.log(`Regressed (we broke):  ${regressed}`);
  console.log(`Expectation mismatches:${expectationMismatches}`);
  console.log(
    `Timing (median/p95 ms): builtin ${timingStats(baselineTimings)?.medianMs}/${
      timingStats(baselineTimings)?.p95Ms
    } | ours ${timingStats(ourTimings)?.medianMs}/${timingStats(ourTimings)?.p95Ms}`,
  );

  const summary = {
    generatedAt: new Date().toISOString(),
    totalFixtures: fixtures.length,
    baselineErrors,
    ourToolErrors: ourErrors,
    improved,
    regressed,
    expectationMismatches,
    timings: { builtin: timingStats(baselineTimings), ours: timingStats(ourTimings) },
    byCategory: {},
    results: report,
  };

  for (const r of report) {
    const cat = r.category;
    if (!summary.byCategory[cat]) summary.byCategory[cat] = { total: 0, improved: 0, regressed: 0 };
    summary.byCategory[cat].total++;
    if (r.improved) summary.byCategory[cat].improved++;
    if (r.regressed) summary.byCategory[cat].regressed++;
  }

  writeFileSync(REPORT_OUTPUT, JSON.stringify(summary, null, 2));
  console.log(`\nWrote report to ${REPORT_OUTPUT}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
