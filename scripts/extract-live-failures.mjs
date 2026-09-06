#!/usr/bin/env node
/**
 * Extract sanitized "in the wild" edit-tool failure fixtures from copied pi
 * session JSONL files living in tmp/ (never the live ~/.pi sessions).
 *
 * Usage:
 *   node scripts/extract-live-failures.mjs
 *
 * Input sessions (copied out-of-band into tmp/, gitignored):
 *   tmp/sessions/deepseek-pi-utils.jsonl
 *   tmp/sessions/stepfun-fingerprint.jsonl
 *
 * Output:
 *   src/__tests__/integration/fixtures/live-failures.json
 *
 * Sanitization:
 *   - absolute paths are reduced to repo-relative form
 *   - any remaining "/home/<user>" occurrences are scrubbed to "~"
 *   - large file snapshots are trimmed to a window around the edit targets
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";

const SESSIONS = [
  { name: "deepseek-pi-utils", path: "tmp/sessions/deepseek-pi-utils.jsonl" },
  { name: "stepfun-fingerprint", path: "tmp/sessions/stepfun-fingerprint.jsonl" },
  { name: "deepseek-newtool-session", path: "tmp/sessions/deepseek-newtool-session.jsonl" },
];

/**
 * --sessions <path|dir> [...]: extract from the given session files instead
 * of the hardcoded list. Directories are expanded to their *.jsonl children
 * (sorted for stable order). Names derive from the file basename, so farm
 * runs stay provenance-addressable via <run-id>-<slot>.jsonl naming.
 */
function resolveCliSessions(argv) {
  const idx = argv.indexOf("--sessions");
  if (idx === -1) return null;
  const targets = [];
  for (let i = idx + 1; i < argv.length && !argv[i].startsWith("--"); i++) {
    targets.push(argv[i]);
  }
  if (targets.length === 0) {
    console.error("--sessions given but no paths; ignoring");
    return null;
  }
  const files = [];
  for (const t of targets) {
    const abs = join(process.cwd(), t);
    const st = statSync(abs);
    if (st.isDirectory()) {
      files.push(
        ...readdirSync(abs)
          .filter((f) => f.endsWith(".jsonl"))
          .sort()
          .map((f) => join(t, f)),
      );
    } else {
      files.push(t);
    }
  }
  return files.map((p) => ({ name: p.split("/").pop().replace(/\.jsonl$/, ""), path: p }));
}

const OUTPUT_FILE = join(
  process.cwd(),
  "tests",
  "integration",
  "fixtures",
  "live-failures.json",
);

/** Max lines of fileContent kept per fixture (windowed around targets). */
const WINDOW_PAD_LINES = 80;

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

function getText(entry) {
  const content = entry.message.content;
  if (typeof content === "string") return content;
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

function buildReadIndex(entries) {
  const index = new Map();
  const byId = new Map(entries.map((e, i) => [e.id, i]));

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    if (entry.message.role !== "toolResult" || entry.message.toolName !== "read") continue;
    const toolCallId = entry.message.toolCallId;
    if (!toolCallId) continue;

    // Walk parent chain to the assistant message holding this tool call.
    let parentId = entry.parentId;
    while (parentId) {
      const idx = byId.get(parentId);
      const parent = idx === undefined ? undefined : entries[idx];
      if (!parent || parent.type !== "message") break;
      if (parent.message.role === "assistant" && Array.isArray(parent.message.content)) {
        const block = parent.message.content.find(
          (c) => c.type === "toolCall" && c.id === toolCallId,
        );
        if (block?.arguments?.path) {
          const path = sanitizePath(block.arguments.path);
          // Truncate markers like "[1171 more lines in file. Use offset=600
          // to continue.]" are renderer chrome, not file content.
          const rawContent = getText(entry).replace(/\n*\[\d+ more lines?[^\]]*\]\s*$/, "\n");
          const list = index.get(path) ?? [];
          list.push({
            content: rawContent,
            line: i + 1,
            offset: typeof block.arguments.offset === "number" ? block.arguments.offset : undefined,
            limit: typeof block.arguments.limit === "number" ? block.arguments.limit : undefined,
          });
          index.set(path, list);
          break;
        }
      }
      parentId = parent.parentId;
    }
  }
  return index;
}

function collectEditCalls(entries) {
  const calls = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    if (entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
    for (const block of entry.message.content) {
      if (block.type !== "toolCall" || block.name !== "edit") continue;
      calls.push({ line: i + 1, id: block.id, args: block.arguments ?? {} });
    }
  }
  return calls;
}

function collectEditResults(entries) {
  const results = new Map();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    if (entry.message.role !== "toolResult" || entry.message.toolName !== "edit") continue;
    results.set(entry.message.toolCallId, { line: i + 1, text: getText(entry) });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Categorization (mirrors the failure taxonomy from docs/session-fixture-recon.md)
// ---------------------------------------------------------------------------

function categorize(args, resultText) {
  if (/must have required propert(y|ies) path/.test(resultText)) {
    const nestedPaths = collectNestedPaths(args);
    if (nestedPaths.length > 0) return "validation-nested-path";
  }
  if (typeof args.edits === "string" && /\/edits: must be array/.test(resultText)) {
    return "validation-edits-string";
  }
  if (resultText.includes("results in no change")) return "already-applied-noop";
  if (/REPLACE text is already present/.test(resultText)) return "already-applied-misfire";
  if (resultText.includes("anchor not found")) return "anchor-not-found";
  if (resultText.includes("SEARCH text not found")) return "not-found";
  return null;
}

function collectNestedPaths(args) {
  if (!Array.isArray(args.edits)) return [];
  return args.edits
    .filter((e) => e && typeof e === "object" && typeof e.path === "string")
    .map((e) => e.path);
}

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

const PROJECT_ROOTS = ["/home/kovalik/projects/pi-utils", "/home/kovalik/projects/pi-opencode-fingerprint"];

export function sanitizePath(raw) {
  let p = String(raw);
  for (const root of PROJECT_ROOTS) {
    if (p.startsWith(root)) p = p.slice(root.length);
  }
  if (p.startsWith("./")) p = p.slice(2);
  return p.replace(/^\/+/, "");
}

export function scrub(text) {
  return text.replaceAll("/home/kovalik", "~").replaceAll("kovalik", "user");
}

/**
 * Trim content to a window covering every needle found (at least one required)
 * plus WINDOW_PAD_LINES of context. Returns { content, trimmed }.
 */
export function windowContent(content, needles, padLines = WINDOW_PAD_LINES) {
  const positions = [];
  for (const needle of needles) {
    if (typeof needle !== "string" || needle.length === 0) continue;
    const idx = content.indexOf(needle);
    if (idx === -1) continue;
    positions.push(idx, idx + needle.length);
  }
  if (positions.length === 0) return { content, trimmed: false };

  const lines = content.split("\n");
  const startLineIdx = content.slice(0, Math.min(...positions)).split("\n").length - 1;
  const endLineIdx = content.slice(Math.max(...positions)).split("\n").length - 1;
  const startLine = Math.max(0, startLineIdx - padLines);
  const endLine = Math.min(lines.length, endLineIdx + padLines + 1);

  return { content: lines.slice(startLine, endLine).join("\n"), trimmed: true };
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

function reconstructFileContent(readIndex, path, needles, beforeLine = Infinity, strictOnly = false) {
  const candidates = readIndex.get(path) ?? [];
  // Only reads that happened BEFORE the failing call describe a state the
  // model could have seen; later reads may reflect other edits (or ours).
  const usable = candidates.filter((c) => c.line < beforeLine);

  for (let i = usable.length - 1; i >= 0; i--) {
    const candidate = usable[i];
    if (needles.every((n) => candidate.content.includes(n))) {
      return { content: candidate.content, readSource: `read@${candidate.line}` };
    }
  }
  // Stitch overlapping pre-call read windows: models reading a big file in
  // offset slices leave no single snapshot covering far-apart needles. Merge
  // offset-adjacent windows whose overlap lines agree byte-for-byte (they
  // must — the region was never edited between them). Fail closed on any
  // disagreement.
  const stitched = stitchWindows(usable, needles);
  if (stitched) return stitched;
  if (strictOnly) return { content: undefined, readSource: "missing" };
  // Relax: prefer later reads containing at least one needle.
  for (let i = usable.length - 1; i >= 0; i--) {
    if (needles.some((n) => usable[i].content.includes(n))) {
      return { content: usable[i].content, readSource: `read@${usable[i].line}:partial` };
    }
  }
  // Last resort: a LATER read that still contains every needle. The
  // needle-guard guarantees the oldText survived whatever happened between
  // call and read, so it is a valid apply target — mark the provenance.
  for (let i = candidates.length - 1; i >= 0; i--) {
    const c = candidates[i];
    if (needles.every((n) => c.content.includes(n))) {
      return { content: c.content, readSource: `read@${c.line}:postcall` };
    }
  }
  return { content: undefined, readSource: "missing" };
}

/**
 * Merge pre-call read windows (offset-known) until every needle is covered.
 * Overlaps must agree exactly; adjacency gaps are tolerated only when the
 * merged result still contains all needles. Returns null when impossible.
 */
function stitchWindows(windows, needles) {
  const known = windows.filter((w) => typeof w.offset === "number" && typeof w.limit === "number");
  if (known.length === 0 || needles.length === 0) return null;
  const sorted = [...known].sort((a, b) => a.offset - b.offset);
  const sources = [];

  let current = null;
  for (const w of sorted) {
    const wLines = w.content.replace(/\n$/, "").split("\n");
    if (!current) {
      current = cloneWindow(w);
      continue;
    }
    const curEnd = current.offset + current.lines.length - 1; // last absolute line
    if (w.offset > curEnd + 1) {
      // Disjoint — flush and start anew.
      sources.push(current);
      current = cloneWindow(w);
      continue;
    }
    const overlapLines = Math.min(curEnd - w.offset + 1, wLines.length);
    if (overlapLines > 0) {
      const tail = current.lines.slice(current.lines.length - overlapLines);
      const head = wLines.slice(0, overlapLines);
      if (tail.join("\n") !== head.join("\n")) return null; // disagree → fail closed
      current.lines = [...current.lines.slice(0, current.lines.length - overlapLines), ...wLines];
    } else {
      current.lines = [...current.lines, ...wLines];
    }
    current.readLines.push(w.line);
  }
  if (current) sources.push(current);

  for (const m of sources) {
    const content = m.lines.join("\n");
    if (needles.every((n) => content.includes(n))) {
      return { content, readSource: `stitch@${m.readLines.join("+")}` };
    }
  }
  return null;
}

function cloneWindow(w) {
  return {
    offset: w.offset,
    lines: w.content.replace(/\n$/, "").split("\n"),
    readLines: [w.line],
  };
}

function buildFixture({
  session,
  call,
  result,
  category,
  path,
  rawEdits,
  fixtureEdits,
  rawContent,
  readSource,
  synthetic,
  suffix,
}) {
  let fileContent = scrub(rawContent);
  let trimmed = false;
  const fixtureOldNeedles = fixtureEdits
    .flatMap((e) => [e.oldText, e.anchor])
    .filter((s) => typeof s === "string" && s.length > 0)
    .map(scrub);
  if (!synthetic) {
    const win = windowContent(fileContent, fixtureOldNeedles);
    fileContent = win.content;
    trimmed = win.trimmed;
  }

  return {
    name: `${session.name}-${call.line}-${call.id.slice(-6)}${suffix}`,
    category,
    path: path || undefined,
    edits: fixtureEdits,
    ...(typeof rawEdits === "string" ? { rawEditsString: scrub(rawEdits) } : {}),
    fileContent,
    fileContentTrimmed: trimmed,
    fileContentSynthetic: synthetic,
    expectedFailureText: scrub(result.text.slice(0, 500)),
    source: {
      session: session.name,
      callLine: call.line,
      resultLine: result.line,
      toolCallId: call.id,
      readSource,
    },
  };
}

function extract(sessions = SESSIONS) {
  const fixtures = [];
  const dropped = [];
  const seen = new Set();

  for (const session of sessions) {
    const raw = readFileSync(join(process.cwd(), session.path), "utf-8");
    const entries = parseSessionEntries(raw);
    const readIndex = buildReadIndex(entries);
    const results = collectEditResults(entries);
    const calls = collectEditCalls(entries);

    for (const call of calls) {
      const result = results.get(call.id);
      if (!result) continue;

      const category = categorize(call.args, result.text);
      if (!category) continue;

      // Normalize args into canonical edits[] + repo-relative path.
      const args = call.args;
      let path = sanitizePath(typeof args.path === "string" ? args.path : "");
      let edits = [];

      if (Array.isArray(args.edits)) {
        edits = args.edits.map((e) => ({
          ...(typeof e.oldText === "string" ? { oldText: e.oldText } : {}),
          ...(typeof e.newText === "string" ? { newText: e.newText } : {}),
          ...(typeof e.anchor === "string" ? { anchor: e.anchor } : {}),
          ...(typeof e.path === "string" ? { path: sanitizePath(e.path) } : {}),
        }));
        if (!path && category === "validation-nested-path") {
          const nested = collectNestedPaths(call.args).map(sanitizePath);
          if (nested.length > 0 && nested.every((p) => p === nested[0])) path = nested[0];
        }
      } else if (typeof args.edits === "string") {
        edits = []; // preserved verbatim below via rawEdits
      }

      // Dedup key: same session + same args signature.
      const key = `${session.name}:${JSON.stringify([path, args.edits])}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Pre-edit snapshots contain oldText but never newText — except the
      // already-applied case where the file already holds the target state.
      const oldNeedles = edits
        .flatMap((e) => [e.oldText, e.anchor])
        .filter((s) => typeof s === "string" && s.length > 0);
      const newNeedles = edits.map((e) => e.newText).filter((s) => typeof s === "string");
      let reconNeedles = oldNeedles;
      if (category === "already-applied-noop") reconNeedles = newNeedles;

      // Only reads strictly before the call are legitimate pre-state.
      const beforeLine = call.line;

      // STRICT pass first: every needle verbatim in one pre-call snapshot
      // (or a verified stitch of overlapping snapshots). If that fails for a
      // multi-block call, try per-block strict — resolveBlocks treats each
      // block as an independent resolve unit, so one fixture per block is
      // faithful and each keeps the real toolCallId provenance. The relaxed
      // whole-call fallbacks (:partial / :postcall) run only when strict
      // reconstruction is impossible at both granularities.
      let { content, readSource } = reconstructFileContent(
        readIndex,
        path,
        reconNeedles,
        beforeLine,
        true,
      );

      // already-applied-noop reconstructs against NEWText needles, so the
      // per-block oldText/anchor needle logic below does not apply to it.
      if (!content && edits.length > 1 && category !== "already-applied-noop") {
        let emitted = 0;
        for (let bi = 0; bi < edits.length; bi++) {
          const e = edits[bi];
          const blockNeedles = [e.oldText, e.anchor].filter(
            (s) => typeof s === "string" && s.length > 0,
          );
          if (blockNeedles.length === 0) continue;
          const blockRecon = reconstructFileContent(
            readIndex,
            path,
            blockNeedles,
            beforeLine,
            true,
          );
          if (!blockRecon.content) {
            dropped.push(
              `${session.name}:${call.line} [${category}] ${path || "(no path)"} block[${bi}]`,
            );
            continue;
          }
          fixtures.push(
            buildFixture({
              session,
              call,
              result,
              category,
              path,
              rawEdits: args.edits,
              fixtureEdits: [e],
              rawContent: blockRecon.content,
              readSource: blockRecon.readSource,
              synthetic: false,
              suffix: `-b${bi}`,
            }),
          );
          emitted++;
        }
        // Every block landed as its own fixture — done. Otherwise fall
        // through to the legacy relaxed whole-call reconstruction.
        if (emitted > 0 && emitted === edits.length) continue;
      }

      if (!content) {
        ({ content, readSource } = reconstructFileContent(readIndex, path, reconNeedles, beforeLine));
      }

      let synthetic = false;
      if (!content && category === "already-applied-noop" && edits.length === 1) {
        // Full-file replacement where the file already equals newText.
        content = edits[0].newText;
        readSource = "synthetic:newText-as-full-file";
        synthetic = true;
      }
      // Without a usable snapshot the fixture cannot replay — drop it.
      if (!content) {
        dropped.push(`${session.name}:${call.line} [${category}] ${path || "(no path)"}`);
        continue;
      }
      fixtures.push(
        buildFixture({
          session,
          call,
          result,
          category,
          path,
          rawEdits: args.edits,
          fixtureEdits: edits,
          rawContent: content,
          readSource,
          synthetic,
          suffix: "",
        }),
      );
    }
  }
  if (dropped.length > 0) {
    console.log(`Dropped ${dropped.length} failures without usable snapshots:`);
    for (const d of dropped) console.log(`  ${d}`);
  }
  return fixtures;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

mkdirSync(join(process.cwd(), "tmp", "sessions"), { recursive: true });

const sessionsArg = resolveCliSessions(process.argv) ?? SESSIONS;
const extracted = extract(sessionsArg);

// MERGE, never overwrite: live-failures.json also holds old-era corpus
// entries (extract-old-era-fixtures.mjs) and hand-curated repros that this
// script must not clobber. Regenerated sessions replace only their own
// entries; everything else is preserved verbatim. Curated per-fixture
// fields (expectApplied, expectPattern, _note) survive regeneration.
const CURATED_FIELDS = ["expectApplied", "expectPattern", "_note"];
let merged = extracted;
if (existsSync(OUTPUT_FILE)) {
  const existing = JSON.parse(readFileSync(OUTPUT_FILE, "utf-8"));
  const sessionNames = new Set(sessionsArg.map((s) => s.name));
  const curatedByName = new Map(
    existing
      .filter((f) => CURATED_FIELDS.some((k) => f[k] !== undefined))
      .map((f) => [f.name, f]),
  );
  for (const fixture of extracted) {
    const prior = curatedByName.get(fixture.name);
    if (prior) {
      for (const k of CURATED_FIELDS) {
        if (prior[k] !== undefined) fixture[k] = prior[k];
      }
    }
  }
  const foreign = existing.filter(
    (f) => !sessionNames.has(f.source?.session ?? ""),
  );
  merged = [...foreign, ...extracted];
}

writeFileSync(OUTPUT_FILE, `${JSON.stringify(merged, null, 2)}\n`);

console.log(`Wrote ${merged.length} fixtures to ${OUTPUT_FILE} (${extracted.length} freshly extracted)`);
const byCategory = new Map();
for (const f of merged) byCategory.set(f.category, (byCategory.get(f.category) ?? 0) + 1);
for (const [cat, n] of byCategory) console.log(`  ${cat}: ${n}`);
