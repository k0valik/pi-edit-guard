#!/usr/bin/env node
// Pass-chain scoring harness — turns "which passes fire / why do failures
// fail" from taste into measurement.
//
//   pnpm exec jiti scripts/score-chain.mjs                     # score tmp/pool/pool.json
//   pnpm exec jiti scripts/score-chain.mjs --fixtures          # calibrate against live-failures.json
//   pnpm exec jiti scripts/score-chain.mjs --limit 200         # quick runs
//
// Per entry (production order: prepareEditArguments -> schema -> executeFile):
//   outcome     full-apply | partial | precise-diagnostic | blind-failure
//   passNames   which chain pass landed each applied block (from match.passName)
//   drift       best-window similarity (pipeline's own Levenshtein/LCS ratio)
//               PLUS token-set Sørensen-Dice and Jaccard — order-insensitive
//               measures that catch chimera/recall-style drift where lines
//               moved or were hallucinated but content tokens survive
//   anchor      does the model's anchor exist verbatim, how often
//
// Buckets for failures:
//   precise-diagnostic  error carries closest-candidate/anchor info
//   blind-failure       generic not-found, low drift everywhere
//   CANDIDATE           high token-drift overlap or a REAL anchor present +
//                       moderate lev similarity — rescuable-shaped, feed the
//                       threshold-tuning agenda
//
// Output: console table + tmp/pool/score-report.json

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const { prepareEditArguments, EDIT_SCHEMA } = await import("../src/core/edit/prepare-arguments.js");
const { Value } = await import("typebox/value");
const { executeFile } = await import("../src/core/edit/execute-file.js");
const { similarity } = await import("../src/core/edit/similarity.js");

// ---------------------------------------------------------------------------
// Token-set similarity (Sørensen-Dice / Jaccard over multiset tokens)
// ---------------------------------------------------------------------------

function tokenize(s) {
  return s.match(/[A-Za-z_]\w*|\d+|[^\w\s]/g) ?? [];
}

function tokenCounts(s) {
  const m = new Map();
  for (const t of tokenize(s)) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

/** Multiset intersection size. */
function intersectSize(a, b) {
  let n = 0;
  for (const [t, c] of a) {
    const bc = b.get(t);
    if (bc) n += Math.min(c, bc);
  }
  return n;
}

function diceTokens(a, b) {
  const ca = tokenCounts(a);
  const cb = tokenCounts(b);
  const na = [...ca.values()].reduce((x, y) => x + y, 0);
  const nb = [...cb.values()].reduce((x, y) => x + y, 0);
  if (na === 0 || nb === 0) return 0;
  return (2 * intersectSize(ca, cb)) / (na + nb);
}

function jaccardTokens(a, b) {
  const ca = tokenCounts(a);
  const cb = tokenCounts(b);
  const inter = intersectSize(ca, cb);
  let na = 0;
  let nb = 0;
  for (const v of ca.values()) na += v;
  for (const v of cb.values()) nb += v;
  const union = na + nb - inter;
  return union === 0 ? 0 : inter / union;
}

// ---------------------------------------------------------------------------
// Best-window drift scan (bounded)
// ---------------------------------------------------------------------------

/**
 * Find the content window most similar to oldText and report all three
 * similarity lenses on it. Scan strategy: seed on occurrences of the
 * longest oldText line (real anchors almost always include one), then try
 * window sizes M±2 lines. Bounded: max 40 seeds × 5 sizes.
 */
function bestWindow(content, oldText) {
  const norm = (s) => s.replace(/\r\n?/g, "\n");
  const cLines = norm(content).split("\n");
  const oLines = norm(oldText).split("\n").filter((l) => l.trim().length > 0);
  if (oLines.length === 0) return null;

  // Longest query line = rarest seed.
  const seed = oLines.reduce((a, b) => (b.length > a.length ? b : a));
  const seeds = [];
  let from = 0;
  while (seeds.length < 40) {
    const at = content.indexOf(seed, from);
    if (at === -1) break;
    // line index of this occurrence
    let line = 0;
    let pos = 0;
    for (let i = 0; i < cLines.length; i++) {
      if (pos + cLines[i].length >= at) {
        line = i;
        break;
      }
      pos += cLines[i].length + 1;
    }
    seeds.push(line);
    from = at + seed.length;
  }
  if (seeds.length === 0) {
    return { lev: 0, dice: diceTokens(oldText, content.slice(0, 4000)), jaccard: jaccardTokens(oldText, content.slice(0, 4000)), found: false };
  }

  const oNorm = oLines.join("\n");
  let best = null;
  const seen = new Set();
  for (const s of seeds) {
    for (const size of [-2, -1, 0, 1, 2]) {
      const start = Math.max(0, s + size);
      const end = Math.min(cLines.length, s + size + oLines.length + 2);
      const key = `${start}:${end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // window: expand to catch the query's span wherever it starts
      const lo = Math.max(0, start - 2);
      const win = cLines.slice(lo, end).join("\n");
      // Quadratic DP budget: oLen*wLen chars of work per window.
      if (oNorm.length * win.length > 4_000_000) continue;
      const lev = similarity(oNorm, win);
      if (!best || lev > best.lev) {
        best = {
          lev,
          dice: diceTokens(oNorm, win),
          jaccard: jaccardTokens(oNorm, win),
          found: true,
          line: lo + 1,
        };
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Pipeline runner
// ---------------------------------------------------------------------------

async function runEntry(entry) {
  const rawArgs = { path: entry.path, ...entry.args };
  let prepared;
  try {
    prepared = prepareEditArguments(rawArgs);
    if (!Value.Check(EDIT_SCHEMA, prepared)) {
      return { outcome: "invalid-schema", passNames: [] };
    }
  } catch (err) {
    return { outcome: "prepare-throw", detail: String(err.message || err).slice(0, 120) };
  }

  const content = entry.fileContent ?? "";
  let result;
  try {
    result = await executeFile(prepared.path, prepared.edits, {
      cwd: "/pool",
      readFile: () => Buffer.from(content),
      writeFile: () => {},
      rename: () => {},
      exists: () => true,
      mkdir: () => {},
      unlink: () => {},
    });
  } catch (err) {
    return { outcome: "execute-throw", detail: String(err.message || err).slice(0, 120) };
  }

  const text = result.content.map((c) => c.text || "").join("\n");
  const details = result.details ?? {};
  const passNames = details.passNames ?? [];
  if (!result.isError && !details.isPartial) return { outcome: "full-apply", passNames };
  if (!result.isError && details.isPartial) return { outcome: "partial", passNames, text };
  return { outcome: "error", text };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const useFixtures = process.argv.includes("--fixtures");
  const limitIdx = process.argv.indexOf("--limit");
  const limit = limitIdx !== -1 ? Number(process.argv[limitIdx + 1]) : Infinity;
  const offsetIdx = process.argv.indexOf("--offset");
  const offset = offsetIdx !== -1 ? Number(process.argv[offsetIdx + 1]) : 0;
  const sampleIdx = process.argv.indexOf("--sample");
  const sampleEvery = sampleIdx !== -1 ? Number(process.argv[sampleIdx + 1]) : 0;

  let entries;
  if (useFixtures) {
    entries = JSON.parse(
      readFileSync(
        join(process.cwd(), "tests/integration/fixtures/live-failures.json"),
        "utf-8",
      ),
    ).map((f) => ({
      path: f.path,
      fileContent: f.fileContent,
      args: { edits: f.edits, ...(f.rawEditsString ? {} : {}) },
      errorText: f.expectedFailureText,
      source: f.name,
    }));
  } else {
    const poolIdx = process.argv.indexOf("--pool");
    const poolPath = poolIdx !== -1 ? process.argv[poolIdx + 1] : "tmp/pool/pool.json";
    entries = JSON.parse(readFileSync(join(process.cwd(), poolPath), "utf-8")).entries;
  }
  let slice = entries.slice(offset, Number.isFinite(limit) ? offset + limit : entries.length);
  if (sampleEvery > 0) slice = slice.filter((_, i) => i % sampleEvery === 0);
  console.log(
    `scoring ${slice.length} entries (${useFixtures ? "fixtures" : "pool"}${offset ? `, offset ${offset}` : ""}${sampleEvery ? `, every ${sampleEvery}th` : ""})`,
  );

  const report = [];
  const t0 = Date.now();
  const timings = [];
  const CHECKPOINT = join(process.cwd(), "tmp", "pool", `score-part-${offset}-${slice.length}.json`);
  for (let i = 0; i < slice.length; i++) {
    const e = slice[i];
    const started = Date.now();
    const rec = {
      source: e.source,
      path: e.path,
    };

    // Perf-guard: known issue #28 hotspot lives in the not-found path on
    // large files; measure it rather than silently burning minutes.
    if ((e.fileContent ?? "").length > 2_000_000) {
      rec.outcome = "skipped-bigfile";
      rec.durationMs = Date.now() - started;
      timings.push({ i, ...rec });
      report.push(rec);
      continue;
    }
    const rawEdits = Array.isArray(e.args?.edits) ? e.args.edits : [];
    if (rawEdits.some((x) => typeof x?.oldText === "string" && x.oldText.length > 8_000)) {
      rec.outcome = "skipped-hugetext";
      rec.durationMs = Date.now() - started;
      timings.push({ i, ...rec });
      report.push(rec);
      continue;
    }

    const r = await runEntry(e);
    rec.durationMs = Date.now() - started;
    timings.push({ i: offset + i, source: e.source, outcome: r.outcome, durationMs: rec.durationMs });
    rec.outcome = r.outcome;
    rec.passNames = r.passNames ?? [];

    if (rec.outcome === "error" || rec.outcome === "partial") {
      const firstOld = rawEdits.find((x) => typeof x?.oldText === "string" && x.oldText.trim());
      const anchor = e.args?.edits?.[0]?.anchor;
      if (firstOld && e.fileContent) {
        const bw = bestWindow(e.fileContent, firstOld.oldText);
        rec.drift = bw
          ? {
              lev: Math.round(bw.lev * 1000) / 1000,
              dice: Math.round(bw.dice * 1000) / 1000,
              jaccard: Math.round(bw.jaccard * 1000) / 1000,
              windowFound: bw.found,
            }
          : null;
      }
      rec.anchorReal = anchor
        ? { inFile: e.fileContent?.includes(anchor) ?? false, occurrences: anchor && e.fileContent ? e.fileContent.split(anchor).length - 1 : 0 }
        : null;
      const hasDiag = /Closest match|closest candidate|Alternatives|already applied|times at line/i.test(r.text ?? "");
      rec.failureClass =
        r.outcome === "partial"
          ? "partial"
          : hasDiag
            ? "precise-diagnostic"
            : rec.drift && (rec.drift.dice >= 0.6 || (rec.anchorReal?.inFile && rec.drift.lev >= 0.45))
              ? "CANDIDATE"
              : "blind-failure";
    }
    report.push(rec);
    if (i % 25 === 24) {
      writeFileSync(
        CHECKPOINT,
        JSON.stringify({ offset, sampleEvery, done: i + 1, report }, null, 0),
      );
    }
    if (i % 100 === 99 || i % 25 === 24) {
      console.log(`  … ${i + 1}/${slice.length} (${Math.round((Date.now() - t0) / 1000)}s)`);
    }
  }

  // Summary
  const by = (k) => report.reduce((m, r) => ((m[r[k] ?? "?"] = (m[r[k] ?? "?"] ?? 0) + 1), m), {});
  const outcomes = by("outcome");
  const classes = {};
  for (const r of report) if (r.failureClass) classes[r.failureClass] = (classes[r.failureClass] ?? 0) + 1;
  const passHits = {};
  for (const r of report) for (const p of r.passNames ?? []) passHits[p] = (passHits[p] ?? 0) + 1;

  const slowest = [...timings].sort((a, b) => b.durationMs - a.durationMs).slice(0, 10);
  console.log("\n=== SLOWEST ENTRIES ===");
  for (const t of slowest) console.log(`  ${String(t.durationMs).padStart(7)}ms  #${t.i} ${t.source} (${t.outcome})`);

  console.log("\n=== OUTCOMES ===");
  for (const [k, v] of Object.entries(outcomes).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(20)} ${v}`);
  console.log("\n=== FAILURE CLASSES ===");
  for (const [k, v] of Object.entries(classes).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(20)} ${v}`);
  console.log("\n=== PASS ATTRIBUTION (applied blocks) ===");
  for (const [k, v] of Object.entries(passHits).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(28)} ${v}`);

  mkdirSync(join(process.cwd(), "tmp", "pool"), { recursive: true });
  writeFileSync(
    join(process.cwd(), "tmp", "pool", "score-report.json"),
    JSON.stringify(
      { builtAt: new Date().toISOString(), offset, sampleEvery, outcomes, classes, passHits, slowest, report },
      null,
      1,
    ),
  );
  console.log("\n-> tmp/pool/score-report.json");

  // Top candidates preview
  const cands = report.filter((r) => r.failureClass === "CANDIDATE").slice(0, 12);
  if (cands.length) {
    console.log("\n=== SAMPLE CANDIDATES ===");
    for (const c of cands) console.log(" ", JSON.stringify({ path: c.path, drift: c.drift, anchor: !!c.anchorReal?.inFile, src: c.source }));
  }
}

main();
