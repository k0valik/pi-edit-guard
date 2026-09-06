#!/usr/bin/env node
/**
 * Snapshot corpus baselines into docs/baselines/<date>/
 *
 * Collects the current state of all three measurement surfaces:
 *   - pool scorer        (tmp/pool/score-report.json, from `pnpm score`)
 *   - live corpus replay (src/__tests__/integration/fixtures/live-replay-report.json)
 *   - session replay     (re-run summary passed via stdin or flags)
 *
 * One folder per day; refuses to overwrite an existing snapshot so history
 * accumulates instead of churning (run on notable changes, before/after
 * experiments, or when a headline number needs pinning).
 *
 * Usage:
 *   pnpm exec jiti scripts/snapshot-baseline.mjs [--date YYYY-MM-DD] [--force]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1] ?? true;
};
const date = flag("--date") ?? new Date().toISOString().slice(0, 10);
const force = args.includes("--force");

const outDir = join(root, "docs", "baselines", date);
if (existsSync(outDir) && !force) {
  console.error(`refusing to overwrite ${outDir} — pass --force to replace today's snapshot`);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

// --- pool score ------------------------------------------------------------
const scorePath = join(root, "tmp", "pool", "score-report.json");
if (existsSync(scorePath)) {
  const r = JSON.parse(readFileSync(scorePath, "utf8"));
  const arr = Array.isArray(r) ? r : r.report ?? r.entries ?? [];
  const by = (fn) => {
    const m = {};
    for (const e of arr) {
      const k = fn(e);
      if (k == null) continue;
      m[k] = (m[k] ?? 0) + 1;
    }
    return m;
  };
  const durs = arr.map((e) => e.durationMs).filter(Number.isFinite).sort((a, b) => a - b);
  const pct = (p) => (durs.length ? Math.round(durs[Math.floor(durs.length * p)]) : null);
  const passes = {};
  let slowest = [];
  for (const e of arr) for (const p of e.passNames ?? []) passes[p] = (passes[p] ?? 0) + 1;
  slowest = [...arr]
    .filter((e) => Number.isFinite(e.durationMs))
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 10)
    .map((e) => ({ index: e.index, durationMs: Math.round(e.durationMs), outcome: e.outcome }));

  const summary = {
    capturedAt: new Date().toISOString(),
    entries: arr.length,
    outcomes: by((e) => e.outcome),
    failureClasses: by((e) => e.failureClass),
    passAttribution: Object.fromEntries(Object.entries(passes).sort((a, b) => b[1] - a[1])),
    timingMs: { median: pct(0.5), p90: pct(0.9), p99: pct(0.99), max: durs.at(-1) ?? null },
    slowest,
  };
  writeFileSync(join(outDir, "pool-score-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(`pool-score-summary.json (${arr.length} entries, max ${summary.timingMs.max}ms)`);
} else {
  console.log("pool-score-summary.json SKIPPED (no tmp/pool/score-report.json — run `pnpm score` first)");
}

// --- live corpus -----------------------------------------------------------
const livePath = join(root, "tests", "integration", "fixtures", "live-replay-report.json");
if (existsSync(livePath)) {
  const r = JSON.parse(readFileSync(livePath, "utf8"));
  const summary = {
    capturedAt: new Date().toISOString(),
    totalFixtures: r.totalFixtures,
    applied: r.applied,
    preciseDiagnostics: r.preciseDiagnostics,
    unexpected: r.unexpected,
    baselineErroredOnRawShape: r.baselineReproduced,
    timings: r.timings,
  };
  writeFileSync(join(outDir, "live-replay-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(
    `live-replay-summary.json (${r.applied} applied / ${r.preciseDiagnostics} precise / ${r.unexpected} unexpected)`,
  );
} else {
  console.log("live-replay-summary.json SKIPPED (no live-replay-report.json — run `pnpm replay:live` first)");
}

// --- session replay -----------------------------------------------------------
const sessPath = join(root, "tests", "integration", "fixtures", "replay-report.json");
if (existsSync(sessPath)) {
  const r = JSON.parse(readFileSync(sessPath, "utf8"));
  const summary = {
    capturedAt: new Date().toISOString(),
    command: "pnpm replay",
    baselineErrors: r.baselineErrors,
    ourErrors: r.ourToolErrors,
    improved: r.improved,
    regressed: r.regressed,
    expectationMismatches: r.expectationMismatches,
    timings: r.timings,
  };
  writeFileSync(join(outDir, "session-replay-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(
    `session-replay-summary.json (${r.baselineErrors} baseline -> ${r.ourErrors} ours, ${r.improved} improved / ${r.regressed} regressed)`,
  );
} else {
  console.log("session-replay-summary.json SKIPPED (no replay-report.json — run `pnpm replay` first)");
}

console.log(`\nbaseline snapshot: docs/baselines/${date}/`);
