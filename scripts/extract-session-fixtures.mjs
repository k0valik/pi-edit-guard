#!/usr/bin/env node
/**
 * Extract real-world edit tool failures from pi session JSONL files and
 * write them as JSON fixtures for integration tests.
 *
 * Uses pi's own session parser (`parseSessionEntries`) for robust JSONL parsing.
 *
 * Usage:
 *   node scripts/extract-session-fixtures.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";

// ===========================================================================
// Sessions to extract from
//
// NOTE: session-failures.json below is the pinned artifact — the raw
// live-repro session JSONLs it was mined from were removed from the repo
// (3.3 MB of logs). Re-running this script re-mines only the sessions
// listed here; to re-mine the old corpus, restore the logs first.
// ===========================================================================

const SESSIONS = [
  {
    name: "agent1-baseline-2026-08-03",
    path: "/tmp/session-agent1-baseline.jsonl",
  },
  {
    name: "agent2-baseline-2026-08-03",
    path: "/tmp/session-agent2-baseline.jsonl",
  },
  {
    name: "agent3-baseline-2026-08-03",
    path: "/tmp/session-agent3-baseline.jsonl",
  },
];

// ===========================================================================
// Helpers
// ===========================================================================

function getText(entry) {
  const content = entry.message.content;
  if (typeof content === "string") return content;
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

function isEditError(entry) {
  // Only treat actual tool errors as error fixtures.
  // Warnings and partial successes are captured separately.
  if (entry.message.isError) return true;

  const text = getText(entry);
  // Partial success: some edits applied, some failed
  if (text.includes("edit(s) failed:") || text.includes("edits failed")) return true;
  if (text.includes("Patch failed")) return true;
  if (text.includes('Validation failed for tool "edit"')) return true;
  if (text.includes("W_ROBUST_EDIT_FALLBACK")) return true;
  if (text.includes("Could not find") && text.includes("oldText must match exactly")) return true;
  if (text.includes("overlap in") || text.includes("overlaps the edit at")) return true;
  if (
    (text.includes("occurrences of edits[") || text.includes("occurrences of the text in")) &&
    text.includes("must be unique")
  )
    return true;
  if (text.includes("No changes made to")) return true;
  if (text.includes("oldText must not be empty")) return true;
  if (text.includes("edits[") && text.includes(".oldText must not be empty")) return true;
  if (text.includes("edits[") && text.includes("ambiguous")) return true;

  // Warnings without overall failure are NOT error fixtures
  // (e.g., "Successfully replaced N block(s)... Warning: Too many closing braces")
  return false;
}
function categorizeError(text) {
  if (text.includes('Validation failed for tool "edit"')) return "validation";
  if (text.includes("Patch failed")) return "patch-failed";
  if (text.includes("overlap in") || text.includes("overlaps the edit at")) return "overlap";
  if (
    text.includes("occurrences of edits[") ||
    text.includes("occurrences of the text in") ||
    (text.includes("edits[") && text.includes("ambiguous"))
  )
    return "ambiguous";
  if (text.includes("No changes made to")) return "noop";
  if (text.includes("oldText must not be empty")) return "validation";
  if (text.includes("Could not find")) return "not-found";
  if (text.includes("edit(s) failed:") || text.includes("edits failed")) return "partial-failure";
  if (text.includes("Warning:") && text.includes("excess:")) return "excess-braces";
  if (text.includes("anchor not found")) return "anchor-not-found";
  if (text.includes("anchor found") && text.includes("times")) return "ambiguous";
  if (text.includes("SEARCH text not found")) return "not-found";
  if (text.includes("must have required properties")) return "validation";
  return "unknown";
}

// ===========================================================================
// Build helper indexes from parsed entries
// ===========================================================================

function buildReadIndex(entries) {
  // Map: path -> [{ content, line, toolCallId }]
  const readIndex = new Map();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    if (entry.message.role !== "toolResult" || entry.message.toolName !== "read") continue;

    const toolCallId = entry.message.toolCallId;
    if (!toolCallId) continue;

    // Walk backward to find the matching tool call and extract path
    let parentId = entry.parentId;
    while (parentId) {
      const parent = entries.find((e) => e.id === parentId);
      if (!parent || parent.type !== "message") {
        parentId = parent?.parentId;
        continue;
      }

      if (parent.message.role === "assistant") {
        const content = parent.message.content;
        if (Array.isArray(content)) {
          const toolCallBlock = content.find((c) => c.type === "toolCall" && c.id === toolCallId);
          if (toolCallBlock?.arguments?.path) {
            const path = toolCallBlock.arguments.path;
            const list = readIndex.get(path) || [];
            list.push({
              toolCallId,
              content: getText(entry),
              line: i + 1,
            });
            readIndex.set(path, list);
            break;
          }
        }
      }

      parentId = parent.parentId;
    }
  }

  return readIndex;
}

// ===========================================================================
// Core extraction
// ===========================================================================

function hasEditContent(content, edit) {
  if (edit.anchor && !content.includes(edit.anchor)) return false;
  if (!content.includes(edit.oldText)) return false;
  return true;
}

function findReadForEdits(readIndex, path, edits) {
  const candidates = readIndex.get(path) || [];
  // Prefer reads closer to the failing edit, but accept any read
  // that contains the edits. Scan in reverse order so later reads
  // are preferred when multiple matches exist.
  for (let i = candidates.length - 1; i >= 0; i--) {
    const candidate = candidates[i];
    if (edits.every((e) => hasEditContent(candidate.content, e))) {
      return candidate;
    }
  }
  return undefined;
}

// ===========================================================================
// Core extraction
// ===========================================================================

function findEditResults(entries, readIndex, sessionName) {
  const results = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    if (entry.message.role !== "toolResult" || entry.message.toolName !== "edit") continue;

    const text = getText(entry);
    if (!isEditError(entry)) continue;

    // Find the matching tool call by walking parent chain
    const toolCallId = entry.message.toolCallId;
    if (!toolCallId) continue;

    let parentId = entry.parentId;
    let call = undefined;

    while (parentId && !call) {
      const parent = entries.find((e) => e.id === parentId);
      if (!parent || parent.type !== "message") {
        parentId = parent?.parentId;
        continue;
      }

      if (parent.message.role === "assistant") {
        const content = parent.message.content;
        if (Array.isArray(content)) {
          const toolCallBlock = content.find(
            (c) => c.type === "toolCall" && c.id === toolCallId && c.name === "edit",
          );

          if (toolCallBlock) {
            const args = toolCallBlock.arguments || {};
            const path = typeof args.path === "string" ? args.path : "";
            let edits = [];

            if (Array.isArray(args.edits)) {
              edits = args.edits.map((e) => ({
                oldText: typeof e.oldText === "string" ? e.oldText : "",
                newText: typeof e.newText === "string" ? e.newText : "",
                anchor: typeof e.anchor === "string" ? e.anchor : undefined,
              }));
            } else if (typeof args.oldText === "string" && typeof args.newText === "string") {
              edits = [{ oldText: args.oldText, newText: args.newText }];
            }

            if (path.length > 0 && edits.length > 0) {
              call = { toolCallId: toolCallBlock.id, path, edits };
            }
          }
        }
      }

      parentId = parent.parentId;
    }

    if (!call) continue;

    let fileContent = undefined;
    let readSource = null;

    // First pass: try exact toolCallId match (fast path)
    const directHit = findReadForEdits(readIndex, call.path, call.edits);
    if (directHit && directHit.toolCallId === toolCallId) {
      fileContent = directHit.content;
      readSource = `direct:${toolCallId}`;
    } else {
      // Second pass: find any read for this path whose content contains
      // the edits. This handles stale reads and missing reads alike.
      const candidate = findReadForEdits(readIndex, call.path, call.edits);
      if (candidate) {
        fileContent = candidate.content;
        readSource = `reconstructed-from-jsonl:${candidate.toolCallId}@${candidate.line}`;
      }
    }

    if (!fileContent) {
      // Fall back to the committed fixture file on disk.
      // These files were checked out between reproductions and may
      // still contain the original baseline edits even when JSONL
      // reads are stale or insufficient.
      const committedPath = join(process.cwd(), call.path);
      try {
        const committed = readFileSync(committedPath, "utf-8");
        const committedHasEdits = call.edits.every((e) => {
          if (e.anchor && !committed.includes(e.anchor)) return false;
          if (!committed.includes(e.oldText)) return false;
          return true;
        });
        if (committedHasEdits) {
          fileContent = committed;
          readSource = "reconstructed-from-committed";
        } else {
          fileContent = `// File content not captured in session for: ${call.path}\n// Extracted from session: ${sessionName} at result line ${i + 1}\n`;
          readSource = "missing";
        }
      } catch {
        fileContent = `// File content not captured in session for: ${call.path}\n// Extracted from session: ${sessionName} at result line ${i + 1}\n`;
        readSource = "missing";
      }
    }

    const expected = { isError: true };
    if (text.includes("Validation failed")) {
      expected.mustContain = "Validation failed";
    } else if (text.includes("W_ROBUST_EDIT_FALLBACK")) {
      expected.mustContain = "W_ROBUST_EDIT_FALLBACK";
    } else if (text.includes("Could not find")) {
      expected.mustContain = "Could not find";
    } else if (text.includes("overlap")) {
      expected.mustContain = "overlap";
    } else if (text.includes("occurrences")) {
      expected.mustContain = "occurrences";
    } else if (text.includes("No changes made")) {
      expected.mustContain = "No changes made";
    } else {
      expected.mustContain = "failed";
    }

    const safeName = `${sessionName}-${i + 1}`.replace(/[^a-zA-Z0-9-_]/g, "-");

    results.push({
      name: safeName,
      category: categorizeError(text),
      path: call.path,
      edits: call.edits,
      fileContent,
      expected,
      source: {
        session: sessionName,
        resultLine: i + 1,
        toolCallId: call.toolCallId,
        timestamp: entry.timestamp,
        readSource,
        contentMissingFromSession: readSource === "missing",
      },
    });
  }

  return results;
}

// ===========================================================================
// Fixture extraction
// ===========================================================================

function extractFixtures() {
  const fixtures = [];

  for (const session of SESSIONS) {
    try {
      const raw = readFileSync(session.path, "utf-8");
      const entries = parseSessionEntries(raw);
      const readIndex = buildReadIndex(entries);
      const results = findEditResults(entries, readIndex, session.name);

      fixtures.push(...results);
    } catch (err) {
      console.error(`Failed to process session ${session.name}:`, err);
    }
  }

  return fixtures;
}

// ===========================================================================
// Main
// ===========================================================================

const OUTPUT_DIR = join(process.cwd(), "tests", "integration", "fixtures");
const OUTPUT_FILE = join(OUTPUT_DIR, "session-failures.json");

try {
  mkdirSync(OUTPUT_DIR, { recursive: true });
} catch {
  // dir may already exist
}

console.log("Extracting fixtures from sessions...");
const fixtures = extractFixtures();
console.log(`Found ${fixtures.length} fixtures`);

writeFileSync(OUTPUT_FILE, JSON.stringify(fixtures, null, 2));
console.log(`Wrote ${OUTPUT_FILE}`);

const byCategory = new Map();
for (const f of fixtures) {
  byCategory.set(f.category, (byCategory.get(f.category) ?? 0) + 1);
}
console.log("\nBy category:");
for (const [cat, count] of byCategory) {
  console.log(`  ${cat}: ${count}`);
}

const missing = fixtures.filter((f) => f.source.contentMissingFromSession);
console.log(`\nFixtures with missing session content: ${missing.length}`);
if (missing.length > 0) {
  console.log("These fixtures have placeholder fileContent and must be reviewed:");
  for (const f of missing) {
    console.log(`  ${f.name} [${f.category}] path=${f.path}`);
  }
}

console.log("\nSample fixtures:");
for (const f of fixtures.slice(0, 5)) {
  console.log(`\n--- ${f.name} ---`);
  console.log(`  path: ${f.path}`);
  console.log(`  category: ${f.category}`);
  console.log(`  edits: ${f.edits.length}`);
  console.log(`  expected.mustContain: ${f.expected.mustContain}`);
  console.log(`  readSource: ${f.source.readSource}`);
  console.log(`  contentMissingFromSession: ${f.source.contentMissingFromSession}`);
}
