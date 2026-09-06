#!/usr/bin/env node
// Rebuilds the cross-session failure pool consumed by scripts/score-chain.mjs.
//
//   node (via jiti) scripts/build-failure-pool.mjs
//   -> tmp/pool/pool.json
//
// Pool entry: { path, fileContent, args, errorText, source }
//   - failing `edit` tool calls paired with their assistant toolCall arguments
//   - snapshot reconstruction: last successful in-session `read` result for the
//     path, with every fully-successful intervening edit replayed on top
//     (verbatim oldText splice; fuzzy-landed edits break the chain and mark
//     the entry unextractable rather than poisoning the pool)
//
// Era filters (from the 2026-08-24 hunt, see edit-failure-hunting skill):
// these signatures belong to OTHER tools or carry no repairable signal —
//   range.*must match pattern, [E_ASYMMETRIC_SHIFT], [E_LINE_CONTENT_MISMATCH],
//   [E_REPLACE_TEXT_*], [E_BAD_REF], "BLOCKED - Edit without read",
//   "retried by matching content by text search", robust-edit hashline schema noise
//
// NEVER mutates session files. Reads only.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

const outIdx = process.argv.indexOf("--out");
const OUT =
  outIdx !== -1
    ? join(process.cwd(), process.argv[outIdx + 1])
    : join(process.cwd(), "tmp", "pool", "pool.json");
const SESSIONS = join(homedir(), ".pi", "agent", "sessions");

// Signatures that are other tools' errors or non-repairable noise.
const EXCLUDE = [
  /range\..*must match pattern/i,
  /\[E_ASYMMETRIC_SHIFT\]/,
  /\[E_LINE_CONTENT_MISMATCH\]/,
  /\[E_REPLACE_TEXT_/,
  /\[E_BAD_REF\]/,
  /BLOCKED - Edit without read/i,
  /retried by matching content by text search/i,
  // ROBUST_EDIT was a fallback tool, not an edit override: its failures are
  // hashline-schema noise, not edit-shape failures.
  /hashline/i,
];

function excluded(text) {
  return EXCLUDE.some((re) => re.test(text));
}

function resultText(m) {
  if (!Array.isArray(m.content)) return "";
  return m.content
    .filter((b) => b && b.type === "text")
    .map((b) => b.text || "")
    .join("\n");
}

// One pass over a session file: emit ordered events so reconstruction can
// walk reads/edits/failures in true sequence.
function loadSession(file) {
  const events = [];
  let raw;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    return events;
  }
  for (const line of raw.split("\n")) {
    if (!line.includes('"toolName"') && !line.includes('"toolCall"')) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type !== "message") continue;
    const m = e.message || {};
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c.type === "toolCall") {
          events.push({ kind: "call", id: c.id, name: c.name, args: c.arguments || {} });
        }
      }
    } else if (m.role === "toolResult") {
      events.push({
        kind: "result",
        id: m.toolCallId,
        toolName: m.toolName,
        isError: !!m.isError,
        text: resultText(m),
      });
    }
  }
  return events;
}

// Extract (path, fileContent, args, errorText) tuples for one session file.
function extractFromFile(file) {
  const events = loadSession(file);
  const pending = new Map(); // callId -> { name, args }

  // Snapshot state per absolute-ish path string as the model spelled it.
  const snapshots = new Map(); // path -> content
  // Edits that succeeded after the last read, for replay-on-read semantics:
  // we instead fold successful edits into the snapshot immediately (splice on
  // verbatim oldText when possible) — same end state, single map.
  const entries = [];

  for (const ev of events) {
    if (ev.kind === "call") {
      pending.set(ev.id, ev);
      continue;
    }
    const call = pending.get(ev.id);
    pending.delete(ev.id);
    if (!call || call.name !== "edit" && ev.toolName !== "edit") {
      if (!call) continue;
    }
    const isEditResult = ev.toolName === "edit" || call?.name === "edit";
    if (!isEditResult) {
      // Possible read result: store snapshot for the read's path.
      if (call && call.name === "read" && !ev.isError) {
        const p = String(call.args.path || "");
        const content = ev.text;
        if (p && content) snapshots.set(p, content);
      }
      continue;
    }

    const p = String(call.args.path || "");
    const errText = ev.text || "";
    if (ev.isError && p && !excluded(errText)) {
      const snap = snapshots.get(p);
      entries.push({
        path: p,
        fileContent: snap ?? null,
        args: call.args,
        errorText: errText.slice(0, 500),
        source: basename(file),
        reconstructable: snap != null,
      });
      continue;
    }
    // Success (or partial): fold into the snapshot so later failures see the
    // evolved state. Verbatim splice only; fuzzy-landed successes invalidate.
    if (!ev.isError && p) {
      const snap = snapshots.get(p);
      const edits = Array.isArray(call.args.edits) ? call.args.edits : [];
      if (snap == null) continue; // nothing to evolve
      let cur = snap;
      let ok = true;
      for (const ed of edits) {
        const ot = typeof ed.oldText === "string" ? ed.oldText : null;
        if (ot == null || !cur.includes(ot)) {
          ok = false;
          break;
        }
        cur = cur.slice(0, cur.indexOf(ot)) + (ed.newText ?? "") + cur.slice(cur.indexOf(ot) + ot.length);
      }
      if (ok) snapshots.set(p, cur);
      else snapshots.delete(p); // chain broken — future failures unreconstructable
    }
  }
  return entries;
}

function main() {
  if (!existsSync(SESSIONS)) {
    console.error("no sessions dir at", SESSIONS);
    process.exit(1);
  }
  const pool = [];
  let files = 0;
  for (const scope of readdirSync(SESSIONS)) {
    const dir = join(SESSIONS, scope);
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl") || name.endsWith(".exit.jsonl")) continue;
      files++;
      pool.push(...extractFromFile(join(dir, name)));
    }
  }

  const reconstructable = pool.filter((e) => e.reconstructable);
  mkdirSync(join(process.cwd(), "tmp", "pool"), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        builtAt: new Date().toISOString(),
        sessionsScanned: files,
        totalFailures: pool.length,
        reconstructable: reconstructable.length,
        entries: reconstructable.map(({ reconstructable: _r, ...rest }) => rest),
        droppedUnreconstructable: pool.length - reconstructable.length,
      },
      null,
      1,
    ),
  );
  console.log(`scanned ${files} session files`);
  console.log(`failing edit calls: ${pool.length}`);
  console.log(`reconstructable:    ${reconstructable.length}`);
  console.log(`dropped (no/broken snapshot): ${pool.length - reconstructable.length}`);
  console.log(`-> ${OUT}`);
}

main();
