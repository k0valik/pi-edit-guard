#!/usr/bin/env node
/**
 * Replay the LIVE failure corpus (real model-produced errors extracted from
 * pi sessions) through our full pipeline: the exact raw arguments the model
 * originally sent go into registerEditTool's execute(), so argument repair
 * (nested-path hoisting, edits-as-string parsing, deletion inference,
 * placeholder cleanup), the match chain, and diagnostics all get exercised.
 *
 * Writes live-replay-report.json into the fixtures dir (gitignored artifact).
 *
 * The builtin tool is additionally probed with the same raw arguments as an
 * authenticity check: it must error natively (these fixtures were recorded
 * as native-tool failures).
 *
 * Usage:
 *   pnpm exec jiti scripts/replay-live-failures.mjs
 *
 * Must run through jiti: the src/ tree uses TS-style ".js" specifiers that
 * plain Node's type stripping does not resolve.
 *
 * Outputs live-replay-report.json (path overridable via LIVE_REPLAY_REPORT).
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import { createEditToolDefinition } from "@earendil-works/pi-coding-agent";
import { createPiMock, makeCtx } from "../packages/pi-base/src/pi-mock.js";
import { registerEditTool } from "../src/platform/tools/edit.js";
import { EDIT_SCHEMA } from "../src/repair/entry.js";

// ===========================================================================
// Config
// ===========================================================================

const LIVE_FIXTURES = join(
  process.cwd(),
  "tests",
  "integration",
  "fixtures",
  "live-failures.json",
);
const REPORT_OUTPUT =
  process.env.LIVE_REPLAY_REPORT ??
  join(process.cwd(), "tests", "integration", "fixtures", "live-replay-report.json");

// Categories where the recorded failure must become a successful apply.
const APPLY_EXPECTED = new Set([
  "validation-nested-path",
  "validation-edits-string",
  "oldera-drifted-recovered",
  "oldera-multi-recovered",
  "oldera-boundary-drift",
  "oldera-deletion-validation",
  "oldera-empty-placeholder",
  "anchor-window-miss",
  "insertion-missing-oldtext",
  // Model oldText is a chimera of two sibling regions (conflated recall):
  // real title/comment lines + hallucinated body scaffolding. Anchor scopes
  // the window; block_anchor absorbs the drifted middle.
  "chimera-recall-drift",
]);

// Categories where a PRECISE diagnostic (not blind failure) is the goal.
function diagnosticPattern(category) {
  if (category === "already-applied-noop") return /already applied/;
  if (category === "oldera-gone-diagnostic") return /Closest match|could not be applied/i;
  if (category === "oldera-ambiguous-diagnostic") return /times|unique|replaceAll/i;
  if (category === "insertion-missing-oldtext") {
    return /nothing to search for|identical; this edit does nothing/;
  }
  return null;
}

// ===========================================================================
// Tool setup
// ===========================================================================

const { readFile, writeFile, access } = await import("node:fs/promises");

const realOps = {
  readFile: (p) => readFile(p),
  writeFile: (p, content) => writeFile(p, content),
  access: (p) => access(p),
};

const pi = createPiMock();
registerEditTool(pi);

function ourTool() {
  return pi.tools[0];
}

// ===========================================================================
// Raw argument reconstruction (mirrors live-failures-replay.test.ts)
// ===========================================================================

function rawArgsFor(f) {
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

// ===========================================================================
// Replay
// ===========================================================================

async function replayWithBuiltinTool(fileContent, rawArgs, absolutePath, cwd) {
  const tool = createEditToolDefinition(cwd, { operations: realOps });
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, fileContent, "utf-8");
  try {
    await tool.execute("replay-tool-call", rawArgs, undefined, undefined, { cwd });
    return { isError: false };
  } catch (err) {
    return { isError: true, text: err instanceof Error ? err.message : String(err) };
  }
}

async function replayWithOurTool(fileContent, rawArgs, tempDir, cwd) {
  // Production order: pi calls prepareArguments on the model's raw args,
  // validates the result against the schema, and only then executes.
  // Unrepairable arguments THROW from prepare with the targeted hint —
  // that is a precise diagnostic outcome, not a harness crash.
  const tool = ourTool();
  let prepared;
  try {
    prepared =
      typeof tool.prepareArguments === "function" ? tool.prepareArguments(rawArgs) : rawArgs;
  } catch (err) {
    return {
      ms: 0,
      schemaValid: false,
      isError: true,
      text: err instanceof Error ? err.message : String(err),
    };
  }

  if (!Value.Check(EDIT_SCHEMA, prepared)) {
    return {
      ms: 0,
      isError: true,
      schemaValid: false,
      text: "prepared args failed EDIT_SCHEMA validation",
    };
  }

  // The prepared path (possibly hoisted from edits[0]) decides where the
  // target file must live in the sandbox.
  const absolutePath = isAbsolute(prepared.path) ? prepared.path : join(tempDir, prepared.path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, fileContent, "utf-8");

  const t0 = performance.now();
  try {
    const result = await tool.execute(
      `live-${randomUUID().slice(0, 8)}`,
      prepared,
      undefined,
      undefined,
      makeCtx({ cwd }),
    );
    const ms = performance.now() - t0;
    return {
      ms,
      schemaValid: true,
      isError: !!result.isError,
      text: result.content.map((c) => c.text || "").join("\n"),
    };
  } catch (err) {
    return {
      ms: performance.now() - t0,
      schemaValid: true,
      isError: true,
      text: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Classify our outcome against what the fixture category promises. */
function classify(fixture, outcome) {
  // Per-fixture overrides first: some categories deliberately mix outcomes
  // (already-applied-misfire holds rescued b1s AND diagnostic b0s), which a
  // category-level model cannot express.
  if (fixture.expectApplied === true) {
    return outcome.isError ? "unexpected-error" : "applied";
  }
  const diag = fixture.expectPattern
    ? new RegExp(fixture.expectPattern, "i")
    : diagnosticPattern(fixture.category);
  if (!outcome.isError) {
    return APPLY_EXPECTED.has(fixture.category) ? "applied" : "unexpected-success";
  }
  if (diag && diag.test(outcome.text)) return "precise-diagnostic";
  if (!APPLY_EXPECTED.has(fixture.category) && !diag) return "precise-diagnostic";
  return "unexpected-error";
}

// ===========================================================================
// Main
// ===========================================================================

async function main() {
  console.log("Loading live failure fixtures...");
  const fixtures = JSON.parse(readFileSync(LIVE_FIXTURES, "utf-8"));
  console.log(`Loaded ${fixtures.length} fixtures`);

  const results = [];
  let applied = 0;
  let preciseDiagnostics = 0;
  let unexpected = 0;
  let baselineReproduced = 0;
  const timings = [];

  for (const fixture of fixtures) {
    const runId = randomUUID().slice(0, 8);
    const tempDir = join(tmpdir(), `live-replay-${runId}`);
    mkdirSync(tempDir, { recursive: true });

    const cwd = tempDir;
    const rawArgs = rawArgsFor(fixture);

    console.log(`\n[${fixture.name}] ${fixture.category}`);

    // Authenticity probe: native tool must fail on the original raw shape.
    const nestedPath = fixture.edits.find((e) => typeof e.path === "string")?.path;
    const baselinePath = join(tempDir, nestedPath ?? fixture.path);
    const baseline = await replayWithBuiltinTool(
      fixture.fileContent,
      rawArgs,
      baselinePath,
      cwd,
    );
    if (baseline.isError) baselineReproduced++;
    console.log(`  builtin errors on raw shape: ${baseline.isError}`);

    const outcome = await replayWithOurTool(fixture.fileContent, rawArgs, tempDir, cwd);
    const bucket = classify(fixture, outcome);
    timings.push(outcome.ms);

    if (bucket === "applied" || bucket === "precise-diagnostic") {
      if (bucket === "applied") applied++;
      else preciseDiagnostics++;
    } else {
      unexpected++;
    }
    console.log(`  our pipeline: ${bucket} (${outcome.ms.toFixed(1)}ms)`);
    if (bucket.startsWith("unexpected")) {
      console.log(`  text: ${outcome.text.slice(0, 160).replace(/\n/g, " | ")}`);
    }

    results.push({
      name: fixture.name,
      category: fixture.category,
      path: fixture.path,
      expectedFailureText: fixture.expectedFailureText,
      baselineErroredOnRawShape: baseline.isError,
      schemaValidAfterPrepare: outcome.schemaValid !== false,
      outcome: {
        bucket,
        isError: outcome.isError,
        durationMs: Number(outcome.ms.toFixed(2)),
        text: outcome.text.slice(0, 300),
      },
      source: fixture.source,
    });

    rmSync(tempDir, { recursive: true, force: true });
  }

  const sorted = [...timings].sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const stats = sorted.length
    ? {
        medianMs: Number(pct(0.5).toFixed(2)),
        p95Ms: Number(pct(0.95).toFixed(2)),
      }
    : null;

  console.log("\n=== Live corpus summary ===");
  console.log(`Total fixtures:              ${fixtures.length}`);
  console.log(`Applied (failure -> success):${applied}`);
  console.log(`Precise diagnostics:         ${preciseDiagnostics}`);
  console.log(`Unexpected outcomes:         ${unexpected}`);
  console.log(`Baseline errored on raw args:${baselineReproduced}/${fixtures.length}`);
  console.log(
    `Pipeline timing (median/p95): ${stats?.medianMs}/${stats?.p95Ms}ms`,
  );

  const summary = {
    generatedAt: new Date().toISOString(),
    totalFixtures: fixtures.length,
    applied,
    preciseDiagnostics,
    unexpected,
    baselineReproduced,
    timings: stats,
    results,
  };

  writeFileSync(REPORT_OUTPUT, JSON.stringify(summary, null, 2));
  console.log(`\nWrote report to ${REPORT_OUTPUT}`);
  if (unexpected > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
