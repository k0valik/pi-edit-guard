#!/usr/bin/env node
// Extracts sanitized old-era (native-tool, 2026-04..2026-06) edit failures
// from the wild-corpus produced during the 60d+ session hunt:
//
//   /tmp/opencode/oldhunt/corpus.json            <- failing edit calls + reconstructed snapshots
//   /tmp/opencode/oldhunt/pipeline-results.json  <- our pipeline's outcome per corpus index
//
// Merges new fixtures into src/__tests__/integration/fixtures/live-failures.json
// without touching existing entries. Categories prefixed `oldera-*`.
//
// Sanitization: repo-relative paths (known roots stripped), usernames scrubbed,
// snapshots windowed around target needles. Fixture `source.callLine` holds the
// corpus index (line numbers are not preserved by the corpus builder).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const CORPUS = "/tmp/opencode/oldhunt/corpus.json";
const RESULTS = "/tmp/opencode/oldhunt/pipeline-results.json";
const OUT = join(
  process.cwd(),
  "tests",
  "integration",
  "fixtures",
  "live-failures.json",
);

if (!existsSync(CORPUS) || !existsSync(RESULTS)) {
  console.error("corpus/results not found - run the old-session hunt first");
  process.exit(1);
}

const corpus = JSON.parse(readFileSync(CORPUS, "utf-8"));
const results = JSON.parse(readFileSync(RESULTS, "utf-8"));
const byIndex = new Map(results.map((r) => [r.i, r]));

const ROOTS = [
  "/home/kovalik/.pi/agent/extensions/",
  "/home/kovalik/projects/",
  "/home/kovalik/",
  "/mnt/e/",
  "/tmp/",
];

function sanitizePath(p) {
  let s = String(p || "");
  for (const root of ROOTS) {
    const at = s.indexOf(root);
    if (at !== -1) s = s.slice(at + root.length);
  }
  return s.replace(/kovalik/g, "user").replace(/^\/+/, "");
}

function scrub(text) {
  return String(text).replace(/\/home\/kovalik/g, "/home/user").replace(/kovalik/g, "user");
}

function windowContent(content, needles, padLines = 80) {
  const lines = content.split("\n");
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    for (const n of needles) {
      if (n && lines[i].includes(n)) {
        hits.push(i);
        break;
      }
    }
  }
  // Drifted SEARCH text never appears verbatim; fall back to locating its
  // best fuzzy-boundary window so the fixture still contains the target
  // region the pipeline will match against.
  if (hits.length === 0) {
    for (const n of needles) {
      if (typeof n !== "string" || n.split("\n").length < 3) continue;
      const ol = n.split("\n");
      let best = { sim: -1, start: 0 };
      for (let s = 0; s + ol.length <= lines.length; s++) {
        const first = lineSim(lines[s].trim(), ol[0].trim());
        const last = lineSim(lines[s + ol.length - 1].trim(), ol[ol.length - 1].trim());
        if (Math.max(first, last) < 0.6) continue;
        let total = 0;
        for (let k = 0; k < ol.length; k++) total += lineSim(lines[s + k].trim(), ol[k].trim());
        const sim = total / ol.length;
        if (sim > best.sim) best = { sim, start: s };
      }
      if (best.sim >= 0.75) hits.push(best.start, best.start + ol.length - 1);
    }
  }
  if (hits.length === 0) return null;
  const lo = Math.max(0, Math.min(...hits) - padLines);
  const hi = Math.min(lines.length, Math.max(...hits) + padLines + 1);
  const head = lo > 0 ? ["[... windowed fixture ...]"] : [];
  const tail = hi < lines.length ? ["[... windowed fixture ...]"] : [];
  return [...head, ...lines.slice(lo, hi), ...tail].join("\n");
}

// --- fuzzy-boundary (S1) simulation ----------------------------------------
// Mirrors src/core/edit/passes.ts fuzzyBoundaryFind thresholds so fixtures are
// selected only where the shipped pass deterministically fires.

function lev(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m || !n) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0));
    }
    prev = cur;
  }
  return prev[n];
}

function lineSim(a, b) {
  if (!a && !b) return 1;
  const mx = Math.max(a.length, b.length);
  return mx === 0 ? 1 : 1 - lev(a, b) / mx;
}

/** True when exactly one window matches the fuzzy-boundary criteria. */
function uniqueFuzzyBoundaryWindow(snapshot, oldText) {
  const ol = oldText.split("\n");
  if (ol.length < 3) return false;
  const sl = snapshot.split("\n");
  let qualifying = 0;
  let best = 0;
  for (let s = 0; s + ol.length <= sl.length; s++) {
    const first = lineSim(sl[s].trim(), ol[0].trim());
    const last = lineSim(sl[s + ol.length - 1].trim(), ol[ol.length - 1].trim());
    if (Math.max(first, last) < 0.75) continue;
    let total = 0;
    for (let k = 0; k < ol.length; k++) total += lineSim(sl[s + k].trim(), ol[k].trim());
    const sim = total / ol.length;
    if (sim >= 0.9) {
      qualifying++;
      best = Math.max(best, sim);
    }
  }
  return qualifying === 1 && best >= 0.9;
}

const BOUNDARY_DRIFT_RE = /not found/i;

function isBoundaryDriftCase(entry, result) {
  if (!result || result.cls !== "error") return false;
  const text = result.text ?? "";
  if (!BOUNDARY_DRIFT_RE.test(text)) return false;
  const idxs = [...text.matchAll(/edits\[(\d+)\]/g)].map((mm) => Number(mm[1]));
  const candidates = idxs.length > 0 ? idxs : entry.edits.map((_, k) => k);
  return candidates.some((k) => {
    const o = entry.edits[k]?.oldText;
    return typeof o === "string" && o.length >= 12 && uniqueFuzzyBoundaryWindow(entry.snapshot, o);
  });
}

function classify(entry, i) {
  const r = byIndex.get(i);
  if (!r) return null;
  const n = entry.needle_status ?? [];
  const allPresent = n.length > 0 && n.every(Boolean);
  if (r.cls === "applied" && !allPresent && entry.edits.length > 1)
    return "oldera-multi-recovered";
  if (r.cls === "applied" && !allPresent) return "oldera-drifted-recovered";
  // Diagnostic classes are selected by the pipeline's ACTUAL response so the
  // replay assertions stay deterministic.
  // Boundary-drift BEFORE gone-diagnostic: cases our pipeline used to answer
  // with "Closest match" diagnostics may now be RECOVERED by fuzzy_boundary.
  if (isBoundaryDriftCase(entry, r)) return "oldera-boundary-drift";
  if (r.cls === "error" && /Closest match/i.test(r.text ?? "")) return "oldera-gone-diagnostic";
  if (r.cls === "error" && /times at line|unique/i.test(r.text ?? ""))
    return "oldera-ambiguous-diagnostic";
  if (r.cls === "prep-throw") {
    const hasEmpty = entry.edits.some((e) => !e || Object.keys(e).length === 0);
    const reals = entry.edits.filter((e) => e && Object.keys(e).length > 0);
    if (hasEmpty && reals.length > 0) return "oldera-empty-placeholder";
    const oldOnly =
      reals.length > 0 &&
      reals.every(
        (e) =>
          typeof e.oldText === "string" &&
          e.oldText &&
          !("newText" in e),
      );
    if (oldOnly) return "oldera-deletion-validation";
  }
  return null;
}

const LIMITS = {
  "oldera-drifted-recovered": 8,
  "oldera-multi-recovered": 4,
  "oldera-boundary-drift": 8,
  "oldera-gone-diagnostic": 4,
  "oldera-ambiguous-diagnostic": 3,
  "oldera-deletion-validation": 5,
  "oldera-empty-placeholder": 4,
};

const picked = new Map();
const seenSig = new Set();

for (let i = 0; i < corpus.length; i++) {
  const entry = corpus[i];
  const cat = classify(entry, i);
  if (!cat || picked.size >= 1000) continue;
  if ((picked.get(cat)?.length ?? 0) >= (LIMITS[cat] ?? 0)) continue;

  // Dedupe near-identical payloads across sessions.
  const sig = `${cat}:${entry.edits.map((e) => (e?.oldText ?? "").slice(0, 40)).join("|")}`;
  if (seenSig.has(sig)) continue;

  // For placeholder cases rebuild args including the `{}` entry the model sent.
  let edits = entry.edits;
  if (cat === "oldera-empty-placeholder") {
    edits = [{}, ...entry.edits.filter((e) => e && Object.keys(e).length > 0)];
  }

  const needles = edits.flatMap((e) =>
    [e?.oldText, e?.newText].filter((s) => typeof s === "string"),
  );
  const content = windowContent(entry.snapshot, needles);
  if (!content) continue; // windowing lost the targets -> unusable

  // Deletion cases are only provable when the search text is present and
  // UNIQUE — otherwise the replay would fail on ambiguity, not prove deletion.
  if (cat === "oldera-deletion-validation") {
    const firstOld = edits.find((e) => typeof e.oldText === "string")?.oldText;
    if (!firstOld) continue;
    const occurrences = entry.snapshot.split(firstOld).length - 1;
    if (occurrences !== 1) continue;
  }

  seenSig.add(sig);
  const fixture = {
    name: `old-era-${corpus[i].session.slice(11, 19)}-${i}`,
    category: cat,
    path: sanitizePath(entry.path),
    edits,
    fileContent: content,
    fileContentTrimmed: content !== entry.snapshot,
    expectedFailureText: scrub(entry.err),
    source: { session: entry.session, callLine: i },
  };
  const list = picked.get(cat) ?? [];
  list.push(fixture);
  picked.set(cat, list);
}

const existing = JSON.parse(readFileSync(OUT, "utf-8"));
const known = new Set(existing.map((f) => f.name));
const added = [];
for (const [, list] of picked) {
  for (const f of list) if (!known.has(f.name)) added.push(f);
}

const merged = [...existing, ...added];
writeFileSync(OUT, `${JSON.stringify(merged, null, 2)}\n`);

for (const [cat, list] of picked) console.log(`${cat}: ${list.length}`);
console.log(`added ${added.length} fixtures -> ${OUT} (total ${merged.length})`);
