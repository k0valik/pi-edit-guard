# Session Fixture Recon — Edit Tool Failures

> **Canonical source:** The live `.pi/agent/sessions/...` files must not be touched during fixture extraction. The **copied** session files live in `/tmp/`:
>
> - `/tmp/session-blackhole-2026-07-31.jsonl`
> - `/tmp/session-pi-utils-2026-07-30.jsonl`
> - `/tmp/session-blackhole-2026-07-28.jsonl`
>   All extraction and inspection should run against these copies only.

This document captures how to locate real-world `edit` failures in pi session JSONL files, the taxonomy of failure modes we care about, and the extraction workflow for turning them into reproducible fixtures for the Edit Guard pipeline.

## 1. Session Forensics Tooling

Use the project-local copy when available, otherwise the system-wide copy:

```bash
SCRIPT="/home/kovalik/.pi/agent/.pi/skills/session-forensics/session-forensics.py"
```

Key commands:

```bash
# Entry-type overview
python3 "$SCRIPT" types file.jsonl --limit 5

# Active branch tree
python3 "$SCRIPT" tree file.jsonl --limit 10

# Chronological all-entries timeline
python3 "$SCRIPT" timeline file.jsonl --limit 20

# Search text blocks (default), thinking+toolCalls, or raw JSON
python3 "$SCRIPT" search file.jsonl "pattern" --mode fields --limit 20

# Show specific entries
python3 "$SCRIPT" show file.jsonl 286
python3 "$SCRIPT" show file.jsonl 285-290
```

## 2. Candidate Sessions

| #   | Session file                              | Scope              | Why useful                                                                                                                           |
| --- | ----------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `/tmp/session-blackhole-2026-07-31.jsonl` | `pi-blackhole-dev` | Richest source: 146 `edit` results, 12 `W_ROBUST_EDIT_FALLBACK`, 2 validation failures, plus multi-edit mixed success/failure cases. |
| 2   | `/tmp/session-pi-utils-2026-07-30.jsonl`  | `pi-utils`         | 39 `edit` results, 6 fallback entries, 1 explicit schema validation failure (`edits.0: must be object`), and recovery-match cases.   |
| 3   | `/tmp/session-blackhole-2026-07-28.jsonl` | `pi-blackhole-dev` | 25 `edit` results, 7 fallback entries, different codebase context, higher multi-edit failure diversity.                              |

Counts:

```bash
python3 "$SCRIPT" search "$S1" '"toolName": "edit"' --mode fields --count
python3 "$SCRIPT" search "$S2" '"toolName": "edit"' --mode fields --count
python3 "$SCRIPT" search "$S3" '"toolName": "edit"' --mode fields --count
```

Observed totals:

- S1: 146 total, 132 success, 12 fallback, 2 validation
- S2: 39 total, 32 success, 6 fallback, 1 validation
- S3: 25 total, 18 success, 7 fallback, 0 validation

## 3. What to Search For

Start broad, then narrow:

```bash
# Count edit results
python3 "$SCRIPT" search "$SESSION" '"toolName": "edit"' --mode fields --count

# Find fallback failures
python3 "$SCRIPT" search "$SESSION" "W_ROBUST_EDIT_FALLBACK" --mode fields --limit 20

# Find validation/schema errors
python3 "$SCRIPT" search "$SESSION" "Validation failed for tool" --mode fields --limit 20

# Find not-found / error text
python3 "$SCRIPT" search "$SESSION" "not found|failed|Error|invalid|Validation|must be|SEARCH" --mode fields --limit 20
```

Preferred targets, in priority order:

1. `W_ROBUST_EDIT_FALLBACK` entries — these are retries that already exhausted exact + relaxed matching, so they are the highest-value “can our pipeline repair this?” cases.
2. `Validation failed for tool "edit"` entries — malformed arg shapes, missing fields, wrong types.
3. Edit `toolResult` entries whose text contains `target text was not found` or `SEARCH text not found`.
4. Mixed multi-edit results where some edits succeeded and others failed in the same call.

## 4. Failure Taxonomy

Use this taxonomy when classifying extracted fixtures and designing regression tests.

### 4.1 Text Not Found

The requested `oldText` does not exist in the target file.

Sub-classes:

- **Exact miss** — the model invented or misremembered text; no fuzzy pass can recover it.
- **Stale read** — the file changed after the model read it; the text existed earlier but not at execution time.
- **Whitespace/indentation drift** — trailing whitespace, tab vs spaces, or indent differences.
- **Line-ending drift** — CRLF vs LF vs mixed endings.
- **Context drift** — the surrounding lines changed enough that the block is no longer present.
- **Encoding/BOM drift** — BOM, UTF-8 vs latin1, or smart quotes/dashes.

Example source: S1 line 1392, S1 line 1479, S3 line 635.

### 4.2 Ambiguous Match

The requested `oldText` exists multiple times in the file, and the model did not provide enough context to disambiguate.

Sub-classes:

- **Duplicate block** — identical code block repeated.
- **Near-duplicate** — same block with minor variations; model matched the wrong one.
- **Anchor-ambiguous** — the model supplied an anchor, but that anchor is also non-unique.

Example source: not directly observed in the sampled fallbacks, but this is a known failure mode from the `W_ROBUST_EDIT_FALLBACK` wrapper. Include synthetic fixtures for it.

### 4.3 Partial Apply

A multi-edit call where some edits matched and others did not.

Sub-classes:

- **Mixed success/failure** — at least one edit applied, at least one failed.
- **Order-dependent miss** — an earlier edit changed context such that a later edit’s `oldText` became stale.

Example source: S1 line 702, S1 line 2454, S3 line 617.

### 4.4 Validation / Schema Error

The arguments failed schema validation before matching even started.

Sub-classes:

- **Missing required fields** — missing `path` or `edits`.
- **Wrong type** — `edits` is a JSON string instead of an array.
- **Malformed edit element** — `edits.0: must be object`, missing `oldText`/`newText`.
- **Empty edits array** — schema allows zero edits, but native convention rejects it.
- **Flat args** — the model sent top-level `oldText`/`newText` instead of `edits[]`.

Example source: S2 line 114, S1 line 2378.

### 4.5 Overlap / Invariant Failure

Edits overlap with each other, or the actual matched text disappeared during application.

Sub-classes:

- **Overlapping edits** — two edits target overlapping spans.
- **Post-resolve overlap** — two edits resolved to overlapping spans after fuzzy matching.
- **Invariant violation** — the matched text was not present at apply time.

Example source: covered by existing unit tests; include at least one regression fixture from synthetic cases if not present in sampled sessions.

### 4.6 No-Op

The `oldText` and `newText` are effectively identical after normalization.

Example source: S1 line 745 (`opts` rename no-op).

### 4.7 Recovery Match / Fallback Match

An external retry/recovery layer applied a heuristic match after native/exact matching failed. These are valuable because they show what the model had to do to succeed without our pipeline.

Example source: S2 line 313, S2 line 463 (`recovery matching`).

## 5. Extraction Workflow

### 5.1 Identify a failing edit result

```bash
python3 "$SCRIPT" show "$SESSION" <result-line>
```

Record:

- `toolCallId`
- failure text / error message
- fixture category from the taxonomy above

### 5.2 Extract the failing tool call args

The parent entry is the assistant message that emitted the `toolCall`:

```bash
# If the result is at line N, the parent assistant message is usually at line N-1
python3 "$SCRIPT" show "$SESSION" $((N-1))
```

From that entry, extract:

```json
{
  "toolCallId": "call_...",
  "toolName": "edit",
  "args": {
    "path": "...",
    "edits": [
      {
        "oldText": "...",
        "newText": "...",
        "anchor": "..."
      }
    ]
  }
}
```

### 5.3 Extract the pre-edit file content

If available, use the preceding `read` tool result as the file snapshot the model saw:

```bash
python3 "$SCRIPT" show "$SESSION" $((N-2))
```

If that entry is not a `read` result, walk back until you find the last `read` for the same `path`.

### 5.4 Build the fixture object

```json
{
  "name": "edit-failure-<category>",
  "path": "<file-path-from-toolCall>",
  "oldText": "<the-search-text>",
  "newText": "<the-replacement>",
  "fileContent": "<actual-file-content-at-that-time>",
  "expectedFailure": "not-found|validation|ambiguous|overlap|noop",
  "source": {
    "session": "<session-filename>",
    "toolCallId": "<id>",
    "timestamp": "<when>",
    "resultLine": <line-number>
  }
}
```

Notes:

- Copy the JSONL to `tmp/` before inspection; do not commit session files.
- Normalize paths if needed, but preserve original content for reproducibility.
- For multi-edit fixtures, include the full `edits` array even when only one edit failed.

## 6. Replay Strategy

### 6.1 Unit-style fixture replay

For most fixtures, replay by calling:

1. `prepareEditArguments(args)` — verify repair behavior.
2. `executeFile(path, edits, opts)` — verify execution behavior.

Assertions:

- Does the fixture throw, or does it succeed?
- If repaired, are repair notes present?
- If it succeeds, do the file contents match the expected replacement?
- Do the returned `details.guard` fields show which pass matched?

### 6.2 Harness-style replay

For end-to-end behavior, use pi’s existing test harness utilities:

- `createHarness` from upstream `packages/coding-agent/test/suite/harness.ts`
- `createHarness` from upstream `packages/coding-agent/test/test-harness.ts`
- `fauxProvider()` / `registerFauxProvider()` from `@earendil-works/pi-ai`

Script a faux provider sequence that replays the assistant/toolResult exchange, then assert on the final session state and tool outputs.

Preferred order:

1. Unit tests against `prepareArguments` + `executeFile` — fast, deterministic, easy to debug.
2. Harness tests against the full extension/tool registration — validates wiring, hooks, and mutation queue behavior.

## 7. Fixture Priorities

Based on the recon above, prioritize extraction in this order:

1. S1 multi-edit mixed failures (`analyze-token-estimation.mjs`, `compaction-trigger.test.ts`) — these exercise the hardest path: partial success + later failure.
2. S2 validation failure (`edits.0: must be object`) — exact repro for the stringified-edits repair path.
3. S1/S2 `W_ROBUST_EDIT_FALLBACK` single-edit misses (`README.md`, `CHANGELOG.md`, `string.ts`) — highest-signal not-found cases.
4. S3 high-volume multi-edit failures (`consolidation.ts`) — repeated fallback in the same file.
5. S2 recovery-match cases — useful negative control: our pipeline should succeed where recovery had to guess.

## 8. Next Steps

- [ ] Extract 5–10 fixtures from S1 into `tmp/fixtures/` using the workflow above.
- [ ] Add a replay script/test that feeds fixtures through `prepareEditArguments` + `executeFile`.
- [ ] Define pass/failure criteria per category before expanding to harness replay.
