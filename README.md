# pi-edit-guard

pi's built-in `edit` tool takes model output at face value. When a model emits the wrong field names, double-encoded JSON, or text that doesn't match the file's whitespace exactly, the edit fails. edit-guard interposes a repair-and-match pipeline behind the same `edit` name, fixing malformed arguments before they reach validation and running a 14-pass match chain to find the target text even when whitespace, indentation, or escaping is off. The model keeps calling `edit` exactly as it always has, with no prompt or tool-name changes.

Across 71 real failures mined from live sessions, the built-in tool fails 65 times. edit-guard fully resolves 57 of those, gives the model a precise diagnostic on the remaining 14, and never breaks an edit the built-in tool would have applied correctly. See [By the numbers](#by-the-numbers) for the full breakdown.

## Install

```bash
pi install npm:@k0valik/pi-edit-guard
```

Or from git:

```bash
pi install git:github.com/k0valik/pi-edit-guard
```

## By the numbers

Measured against real failures mined from thousands of agent sessions and reproduced as replayable test fixtures:

| Metric                                   | Built-in `edit` | edit-guard                                                               |
| ---------------------------------------- | --------------- | ------------------------------------------------------------------------ |
| **Live corpus** (71 real model failures) | 65 errors (92%) | **57 fully applied**, 14 with precise diagnostics, 0 unexpected outcomes |
| **Session replay** (44 fixture edits)    | 36 errors       | **23 errors** (13 fixed, 0 regressed)                                    |
| **Failure pool** (1396 mined edit calls) | --              | 606 full-apply, 320 partial-apply, 254 precise diagnostics               |

These numbers count only edits that the pipeline fully resolves. The partial-apply and precise-diagnostic counts represent additional edits where the pipeline either applied a subset successfully, or gave the model a clear closest-candidate or anchor report so it can correct on the next turn - cases that would otherwise be opaque "not found" failures.

**What gets fixed.** Argument repair catches malformed calls before they reach the match engine: double-encoded JSON, field names from differently-shaped training data (`old_string` instead of `oldText`), nested path objects that should be hoisted, stringified edit arrays. The 14-pass match chain then finds the target text even when whitespace, indentation, escaping, or line ordering is wrong - the most common failure modes across every model class tested.

**Speed.** Median match time is 2 ms; p95 is under 650 ms. The pipeline adds negligible latency to successful edits.

**Zero regressions.** Every fixture in the live and session corpora that the built-in tool applies correctly is also applied correctly by edit-guard. No known case where the pipeline makes a working edit fail.

All numbers are reproducible with `pnpm replay`, `pnpm replay:live`, and `pnpm score`. Baselines are pinned in `docs/baselines/`.

## Tools

| Tool   | Description                                                                                                                                                                                                                                                        |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `edit` | Overrides the built-in `edit` tool (extension tools win by name). Argument repair, 14-pass tiered match chain, anchor windows, auto-expand, partial-apply handling, coherence/corruption checks, byte-preserving atomic writes. Killswitch: `editOverrideEnabled`. |
| `undo` | Reverts the most recent `edit`-tool change on a file. Backed by an append-only JSONL store that survives sessions, bounded by FIFO eviction (`undoMaxBytes`). One snapshot per file - last edit wins. Killswitch: `undoEnabled`.                                   |

## Commands

| Command              | Description                                                                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `/edit-guard`        | Status modal: Stats (telemetry counters + stormbreaker totals), Audit (`edit-guard:event` entries), Config (effective configuration summary). |
| `/edit-guard:config` | Open the ConfigManager settings modal with global / project scope tabs.                                                                       |

Registered when the extension loads.

## Configuration

`ConfigManager` (from `@k0valik/pi-base`) with layered resolution: **defaults <- global file <- project file <- environment variables**. Config file: `edit-guard-config.json` (global in the pi extensions dir; project overrides in `.pi/`). Settings modal opens with `/edit-guard:config`.

Key settings at a glance: `editOverrideEnabled` (killswitch), `repairPolicy` (`conservative`/`adaptive`/`recover`), `stormbreakerThreshold` (loop break count), `staleReadToleranceMs` (mtime window), `undoEnabled`.

Full schema, env var mappings, repair policy profiles, and example config: **[CONFIG.md](CONFIG.md)**.

---

<details>
<summary>What happens on one <code>edit</code> call — click to expand</summary>

1. **Preflight** normalizes `path` in place, or blocks a non-existent path before anything runs.
2. **Stale-read check** blocks the call if the file's mtime is newer than the last recorded read (+ tolerance). - Prevents misplaced edits because the mental model of the LLM of the file's shape is incorrect.
3. **Argument repair** runs in the tool's `prepareArguments` slot: envelope decoding, preprocessors, schema-guided repair rules, then TypeBox validation. Repairs surface to the model as `<repair_note>` blocks attached to the result.
4. **Workspace write gate** auto-allows paths inside the workspace or `/tmp`; any other path provides an advisory warning to the model, that the edit landed outside of the workspace.
5. **Core execution** inside pi's per-file mutation queue: read raw bytes, detect encoding, strip BOM, LF-normalize, autopatch, resolve (two-pass), apply, raw-splice onto original bytes, restore BOM, atomic temp-file write.
6. **Post-edit checks** produce advisory warnings: corruption heuristics on inserted text, coherence checks scoped to edited lines.
7. **Undo capture**: if the content actually changed, the pre-edit state is persisted before the result returns, so the model can call the `undo` tool to restore misplaced edits quickly.
8. **Result shaping**: native-parity success text and `details = { diff, patch, firstChangedLine }`, plus an additive `guard` block (pass names, diagnostics, warnings, timing).
9. **Stormbreaker** observes results: matched error patterns get actionable suffixes; repeated identical failures abort the turn once a threshold is reached.

A consolidated telemetry envelope (`edit-guard:envelope` session entry) is emitted exactly once per edit call - success, failure, or abort.

</details>

---

## Edit engine

<details>
<summary>Pipeline overview — click to expand</summary>

`executeFile` (src/core/edit/execute-file.ts) is the pure-core executor - no pi imports; fs ops, the mutation queue, and the stale-read self-refresh callback are injectable. One file end-to-end:

1. Resolve path against cwd (`~` expansion, unicode-space normalization, `@`-prefix stripping, `file://` URLs).
2. Read raw bytes; detect encoding: UTF-8 BOM, then valid UTF-8 re-encode, then latin1 fallback.
3. Strip the BOM (re-prepended on write); LF-normalize line endings for matching.
4. Convert edits to engine blocks (`patchEditsToBlocks`) and run **autopatch** fixes.
5. **Resolve** all blocks (two-pass resolution, below).
6. **Apply** resolved spans bottom-up on normalized content (overlap-checked).
7. Rebuild via **raw-splice**: Pass 1 splices land on the BOM-stripped original bytes, Pass 2 splices land on that intermediate result, so untouched regions keep their exact bytes (CRLF, mixed endings, anything).
8. Restore the BOM, then atomic write: `.edit-guard-{timestamp}-{random}.tmp` in the target directory (parent created recursively, best-effort), renamed over the target; temp file unlinked on failure.
9. Compute corruption/coherence warnings and telemetry; return both LF-normalized pre/post content and raw pre/post content so the tool layer can build native-shape diffs without losing byte fidelity.

If some edits resolve/apply and others fail, the executor takes the **partial-apply path**: it writes the successful edits and reports each failure with block index, reason, and (for ambiguous matches) up to two near-miss alternatives with similarity percentages and line ranges.

</details>

<details>
<summary>Autopatch (pre-resolution fixes) — click to expand</summary>

Three passes mutate `oldText` (and sometimes `newText`) in place before matching. Strict safety gates: original text must have zero matches, the corrected candidate exactly one, and changes must be provably equivalent:

- **Pass 0 - escaped control characters**: model emitted `\t`/`\n` as literal two-character sequences; the escaped variant must match exactly once.
- **Pass 1 - trailing whitespace**: strips per-line trailing whitespace and trailing empty lines from `oldText`.
- **Pass 2 - indentation mismatch**: tab/space conversions plus an indentation-insensitive scan; `newText` leading-whitespace style is retargeted to match the correction.

Every fired pass records an `edit.autopatch` telemetry event.

</details>

<details>
<summary>Resolution and match chain — click to expand</summary>

Validation first: empty `oldText` fails as `validation`; `oldText` equal to `newText` after newline normalization fails as `noop`.

1. **Anchor window** - if `anchor` is provided, locate it with the match chain minus heuristic search-only passes. A redundant anchor (matches nowhere but is >= 0.9 similar to `oldText`) is dropped and matching runs against full content. An ambiguous anchor fails immediately. A missing anchor tries near-miss fallback anchors with similarity > 0.7 before failing with a closest-candidate report. When found, the `oldText` search is restricted to the anchor's line span +/- 10 lines. If `oldText` starts with the anchor but does not fit the window, the engine retries against the full file.
2. **14-pass literal chain (tiered)** - runs in order, short-circuiting on the first hit: `simple`, `line_trimmed`, `whitespace_normalized`, `indentation_flexible`, `escape_normalized`, `unicode_normalized`, `block_anchor`, `block_anchor_levenshtein`, `fuzzy_boundary` (search-only), `trimmed_boundary`, `context_aware`, `robust_trimmed`, `robust_backslash`, `token_overlap`. Order is tiered: deterministic transforms run before anchored-fuzzy passes, which run before loose legacy scans. Every pass returns text verified with `original.includes(actual)` - matched text is always verbatim file content, never the query.
3. **Already-applied detection** - when nothing matches but the normalized `newText` is present verbatim, the error reports "already applied" instead of "not found".
4. **Disproportionate guard** - even a passing match is rejected if the matched span is far larger than the query.
5. **Uniqueness** - occurrences of the actual matched text are counted within the search scope. More than one is ambiguous.
6. **Auto-expand** - on ambiguity, context grows symmetrically around each occurrence. Exactly one unique candidate wins.
7. **Closest candidate** - if no pass matched, the nearest near-miss window is reported regardless of threshold so the model can correct against real file content.

</details>

<details>
<summary>Two-pass resolution — click to expand</summary>

Pass 1 resolves every block against the original normalized content. Only if some blocks resolved while others failed with `not-found` / `anchor-not-found` does Pass 2 re-resolve the missing blocks against the post-Pass1 content; diagnostics are remapped back to original block indices. Pass 1 offsets are applied first, then Pass 2 edits apply sequentially on that result so their coordinates stay valid.

</details>

<details>
<summary>Apply and byte preservation — click to expand</summary>

`applyEdits` detects overlapping spans on the original content before any replacement, then applies bottom-up (highest start first). Each splice verifies the matched text still sits at its span: an overlap casualty fails as `already-handled`; anything else fails as `invariant`. No-op splices are rejected.

`buildNormToRawMap` walks raw content and its LF-normalized form in lockstep, mapping normalized offsets to raw offsets. `spliceOntoRaw` rebuilds the file from the original bytes; only matched spans receive new text. Mixed line endings, CRLF, and every untouched byte survive.

</details>

<details>
<summary>Result warnings (advisory, never blocking) — click to expand</summary>

- **Corruption heuristics** run on the spliced result before writing: inserted text duplicating a consecutive block from the matched region (with expansion-ratio gates), duplication of context adjacent to the splice, prefix echoes of the matched block (>= 20 chars), and cascading duplicates of previously inserted text. Short replacements (< 120 chars) are skipped to avoid false positives.
- **Coherence check** (config `coherenceCheckEnabled`, default off) flags suspicious indentation jumps (> 8 spaces) between lines at the same brace depth within +/- 6 lines of the edited region; string-literal lines are skipped.
- Warnings surface in the result text under `[WARNINGS]`, in `details.guard`, and as a UI notification when `warningsEnabled` is on.

</details>

For the full pipeline internals (byte maps, raw-splice mechanics, two-pass resolution details), see **[ARCHITECTURE.md](ARCHITECTURE.md)**.

---

## Argument repair

<details>
<summary>Full repair pipeline — click to expand</summary>

The `edit` override runs `prepareEditArguments` before schema validation. When `repairEnabled` is true it delegates to `runRepairPipeline`; when disabled, a native-compatibility subset still runs (parse stringified `edits`, drop empty entries, fold flat keys) so argument compatibility never regresses.

Pipeline stages, in order:

1. **Envelope recovery** - decodes JSON-stringified tool arguments (bounded: 256 KB input, depth 64, 3 decode attempts, 25 ms budget), escapes raw control characters, unwraps singleton object arrays, and - when policy allows - completes truncated envelopes against candidate suffixes.
2. **Preprocessors** (structural rewrites with model-facing notes):
   - parse a JSON-stringified `edits` array (tolerating literal newlines, repairing under-escaped quotes via JSON.parse error positions, up to 5 rounds, and punctuation debris such as trailing commas / short dangling fragments)
   - filter empty-string entries from `edits[]`
   - drop empty-object `{}` placeholder entries
   - field aliases at any depth: `path` accepts `file_path`/`filePath`/`pathname`/`target_file`/`file`; `oldText` accepts `old_string`/`oldString`/`old_str`/`oldStr`/`from`; `newText` accepts `new_string`/`newString`/`new_str`/`newStr`/`to`
   - deletion inference: an edit with only `oldText` defaults `newText` to `""`
   - nested-path hoisting: when every edit carries the same inner `path` and no root path exists, it is hoisted to the root
   - flat fold: top-level `oldText`/`newText` (+ optional `anchor`/`replaceAll`, snake_case accepted) are appended as a new `edits` entry
3. **Schema-guided repair** - up to three passes over the strict validator's issue sites, rules applied in fixed order: rename aliased fields, drop null/undefined fields, drop empty-object placeholders, parse JSON-stringified arrays then objects, wrap bare strings as single-element arrays.
4. **Final validation** through TypeBox `Convert`/`Check`, preserving benign native coercions (`"5"` -> 5). Strictly-invalid inputs that Convert would silently corrupt (`null` -> `"null"`) are repaired first or rejected instead.

Markdown auto-links in path fields are unwrapped unconditionally (`[notes.md](http://notes.md)` -> `notes.md`). Unrepairable inputs throw a model-facing retry message listing the schema failures, enriched with targeted hints for known dead-ends.

Three policy profiles control aggressiveness:

| Profile        | Truncated-envelope completion | Valid-value transforms | Grammar mode |
| -------------- | ----------------------------- | ---------------------- | ------------ |
| `conservative` | off                           | off                    | observe      |
| `adaptive`     | on                            | on                     | strip        |
| `recover`      | on                            | on                     | recover      |

**Repair notes channel.** `prepareArguments` has no result channel and no `toolCallId`, so outcome notes park in a TTL-bounded `RepairLifecycle` keyed on stable-serialized repaired args. `execute` correlates by `(toolName, args)` and takes by `toolCallId` to attach `<repair_note>` blocks to the result. Misses are harmless: notes are lost, never attached to the wrong call.

</details>

---

## Hooks

| Hook                  | Events                               | Description                                                                                                                                                                            |
| --------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preflight`           | `tool_call`                          | Normalizes paths in place (strips quotes/whitespace, resolves relative to cwd); blocks non-existent paths with near-match suggestions. Covers read/edit/write/ls/grep/find.            |
| `stale-read-observer` | `tool_call`, `tool_result`, shutdown | Records mtimes on successful reads; blocks `edit` when the file changed since the last read; self-heals after the agent's own `edit`/`write`/`undo`.                                   |
| `overwrite-guard`     | `tool_call` (`write` only), shutdown | Blocks the first `write` to an existing non-empty file per session with a nudge toward `edit`; the second attempt passes.                                                              |
| `stormbreaker`        | `tool_result`, `tool_execution_end`  | Enhances cryptic tool errors into actionable diagnostics; breaks repeated-failure loops via a per-tool sliding window (last 10 failures); auto-resumes with a corrective retry prompt. |

## Path preflight

<details>
<summary>How preflight works — click to expand</summary>

Runs on `tool_call` for exactly six tools: `read`, `edit`, `write`, `ls`, `grep`, `find`. It extracts the first matching path argument (`path`, then `file_path`; ls/grep/find treat it as optional), trims whitespace, strips surrounding quotes, and resolves relative to cwd. Outcomes:

- **pass** - already normalized (and exists, for read-like tools).
- **normalized** - mutated `event.input[key]` in place.
- **block** - path does not exist; reason includes up to three near-match suggestions (Levenshtein distance <= max(2, floor(basename length x 0.34)) against directory entries).

For `write`, existence is skipped and the parent directory is created recursively; creation failure blocks the call.

</details>

## Stale-read protection

<details>
<summary>How stale-read works — click to expand</summary>

A `ReadRegistry` records the wall-clock time of every successful `read`. Before an `edit` executes, staleness is judged by mtime: newer than the last read (+ tolerance, default 500 ms) blocks the call with "re-read the file and retry". After the agent's own successful `edit`, `write`, or `undo` result - and inside the executor after its own write - the registry self-refreshes so its own writes never self-block. A file never read is always fresh.

</details>

## Stormbreaker

<details>
<summary>Error enhancement and loop breaking — click to expand</summary>

**Error enhancement (`tool_result`).** Error text is pattern-matched and suffixed with actionable guidance: no-such-file (with a special case for empty path arguments), permission denied, edit exact-string-not-found (stale read / whitespace hints), offset beyond end of file. Everything unmatched is prepended with `[toolName]`.

**Loop breaking (`tool_execution_end`).** Failures land in a per-tool sliding window (last 10). Each failure is normalized into a signature - paths, line numbers, ISO timestamps, and hex addresses stripped, capped at 200 chars - so any single signature reaching the threshold (default 3, clamped 1-10) breaks the loop, including interleaved A,B,A,B,A patterns. On break: `ctx.abort()`, a user-visible message plus `edit-guard:stormbreaker` session entry, and a UI warning.

**Auto-continue.** Instead of parking the session until you respond, a broken loop auto-resumes after `stormbreakerRetryDelayMs` (default 3000, clamped 1000-10000) with a corrective retry prompt delivered as a follow-up turn (`triggerTurn: true`). The prompt restates the failed tool and failure count and gives tool-specific corrective steps. Every retry prompt ends with "if the same failure repeats, stop and explain the blocker instead of looping". Disable with `stormbreakerAutoContinue: false` to keep the manual pause.

</details>

## Overwrite guard

<details>
<summary>How overwrite guard works — click to expand</summary>

**Disabled by default.** Enable with `overwriteGuardEnabled: true` in your config.

Intercepts `write` calls: the first attempt per file per session to overwrite an existing non-empty file is blocked with a nudge toward `edit` (line count included). The second attempt passes unconditionally. New files and empty-file overwrites always pass. State resets on `session_shutdown`.

**Why you might want this.** Small local models (especially smaller Qwen, CodeLlama, and Phi variants) sometimes produce `write` calls that silently drop large chunks of code -- they overwrite the file from a stale or partial in-memory view instead of using `edit` for targeted changes. Enabling this guard forces those models toward `edit`, which is the correct tool for modifying existing files.

</details>

## Undo

<details>
<summary>Undo store details — click to expand</summary>

The `undo` tool reverts the most recent `edit`-tool change on a file. Gated by `undoEnabled`.

- **Store**: append-only JSONL dump - one line per record, deletions append tombstones, last line per path wins. Single O_APPEND writes keep concurrent sessions from clobbering each other; reads are stateless (the dump is re-read every operation); torn/malformed lines are skipped, never fatal.
- **Location**: `PI_UNDO_STORE_PATH` if set, else `<pi-agent-dir>/pi-better-toolcalls-undo-store.jsonl`, else `~/.local/state/pi-better-toolcalls/undo-store.jsonl`.
- **Bounds**: FIFO eviction at `undoMaxBytes` (default 5 MB, clamped 64 KB - 50 MB); oldest-updated records dropped first, newest always kept. Records survive sessions by design.
- **Capture**: the `edit` tool persists the pre-edit snapshot (LF-normalized + raw bytes + BOM + line ending + encoding + session/project provenance) only when content actually changed; persistence failure throws `[E_UNDO_UNAVAILABLE]`.
- **Staleness**: undo compares current raw file bytes against the stored post-edit snapshot (BOM-prefixed, line-ending-restored). Mismatch clears the entry and reports stale with the snapshot's age and originating session.

</details>

For the full implementation details of every guard, see **[ARCHITECTURE.md](ARCHITECTURE.md)**.

---

## Telemetry

<details>
<summary>Telemetry internals — click to expand</summary>

**Local only.** All telemetry stays on your machine. Nothing is sent anywhere. Telemetry is an internal audit trail so you can inspect what the pipeline fixed, which passes fired, and how often - useful for debugging and for understanding the extension's behavior in your sessions.

`EditGuardTelemetry` (src/core/telemetry.ts) is a pure, pi-free singleton with two simultaneous sinks:

- **Counters** aggregate everything `/edit-guard` shows: events recorded, edits applied per pass name, repair rules fired, unrepairable fingerprints, preflight normalized/blocked, stale-read blocked/self-healed, stormbreaker enhanced/loops-broken (plus per-tool), anchor used/not-found/ambiguous/redundant-dropped, already-applied count, auto-expand count, mean edit duration, closest-candidate count and mean similarity, write-guard denials, overwrite-guard blocks, partial edits, autopatch corrections, envelopes emitted, and warning totals.
- **Ring buffer** holds the last 50 events, drained into the audit trail on `session_start`. Draining never resets counters.

The sink is attached in `extension.ts` and forwards each event to `pi.appendEntry("edit-guard:event", ...)` only when `telemetryEnabled` is on; sink failures are isolated so telemetry can never break an edit.

Event kinds: `repair.rule`, `match.pass`, `match.closest_candidate`, `anchor.not_found`, `anchor.redundant_dropped`, `anchor.ambiguous`, `match.already_applied`, `preflight.normalized`, `preflight.blocked`, `stale_read.blocked`, `stale_read.self_healed`, `write_guard.denied`, `stormbreaker.enhanced`, `stormbreaker.loop_broken`, `edit.applied`, `edit.partial`, `edit.autopatch`, `overwrite_guard.blocked`, `edit.envelope`.

**Envelopes.** Each edit call opens a telemetry envelope before execution and closes it exactly once - on success, failure, or abort - appending an `edit-guard:envelope` session entry containing path, applied/failed counts, deduplicated pass names, anchor flag, duration, repair rules fired during the call, warning arrays, closest candidate, and repair notes.

</details>

---

## Development

| Command          | Purpose                                         |
| ---------------- | ----------------------------------------------- |
| `pnpm typecheck` | Type-check with `tsc --noEmit`.                 |
| `pnpm lint`      | Lint with `oxlint .`.                           |
| `pnpm fmt`       | Format with `oxfmt .`.                          |
| `pnpm test`      | Run vitest (`vitest run`).                      |
| `pnpm check`     | Full gate: typecheck + lint + fmt:check + test. |
| `pnpm build`     | Bundle with `tsup`.                             |

**Packaging**: ESM (`"type": "module"`); main entry `src/extension.ts`; root `extension.ts` re-exports it for older `pi.extensions` entries. `tsup` bundles to `dist/` (ESM, tree-shaken) with pi packages and typebox external. Pi packages are optional peer dependencies; typebox is a runtime dependency. Node >= 24.18.0.

**Tests**: vitest, two projects - `pi-extension-template` (`src/**/*.test.ts`, `__tests__/**/*.test.ts`) and `pi-base` (`packages/pi-base/**`). Integration replay tests live in `tests/integration/` with fixtures under `fixtures/`. Default timeout 15 s.

<details>
<summary>Source layout — click to expand</summary>

- `src/extension.ts` - thin wiring: registers hooks/tools/commands, attaches the telemetry audit sink, reloads config on `session_start`, clears the repair lifecycle on `session_shutdown`.
- `src/index.ts` - barrel re-exports for tests and external consumers.
- `src/core/` - pure functions, zero pi imports: edit engine (`src/core/edit/`, incl. argument preparation and the robust-match passes), repair pipeline (`src/core/repair/`), stormbreaker core (`src/core/errors/`), preflight (`src/core/preflight/`), config (`src/core/config/`), telemetry (`src/core/telemetry.ts`).
- `src/hooks/` - `pi.on()` handlers: `stormbreaker.ts`, `stale-read-observer.ts`, `preflight.ts`, `overwrite-guard.ts`.
- `src/tools/` - `registerTool()` implementations: `edit-tool.ts` (the override), `undo-tool.ts`, `write-guard.ts` (workspace write gate used by the edit tool).
- `src/commands/` - `registerCommand()`: `edit-guard.ts`.
- `packages/pi-base/` - shared infrastructure (ConfigManager, settings modal, mocks, shell utils).

</details>

---

## Integration testing

<details>
<summary>Fixture layout and measurement loop — click to expand</summary>

Everything else in this repo exists to answer one question with real data:
**does the guarded pipeline rescue failures that pi's built-in edit cannot?**
The evidence chain is: hostile fixture files -> recorded agent sessions ->
extracted failure corpora -> replay gates -> pinned baseline numbers.

```
tests/integration/fixtures/
├── files/               22 deliberately hostile fixture files (+ MANIFEST.json,
│   └── missions/        target map). missions/ = the in-world ticket queue the
│                        recording farm's agents work through (they never see
│                        anything about edit tools - naturalistic failures only).
├── farm-sessions/       raw sessions from the recording farm land here (tracked).
│                        Empty until first batch.
├── session-failures.json   OLD corpus: 44 extracted failures (mined from the
│                        live-repro agent-a..g sessions; raw logs removed to
│                        keep the repo lean - this file is the pinned artifact),
│                        baseline-error taxonomy (patch-failed,
│                        partial-failure, ambiguous...). Consumed by `pnpm replay`
│                        which compares builtin-edit baseline vs our pipeline
│                        on each.
└── live-failures.json      CURRENT corpus: ~71 curated failures in a mechanism
                         taxonomy (chimera-recall-drift, already-applied-misfire,
                         validation-nested-path...). Each carries expected outcome +
                         provenance (session, line, toolCallId). Consumed by
                         `pnpm replay:live`; gate = 0 unexpected outcomes.
docs/
├── baselines/<date>/    PINNED numbers from `pnpm baseline` (pool score, live
│                        corpus, session replay). One folder per day; history
│                        accumulates. This is where improvement claims live.
├── recording-farm-runbook.md   how the orchestrator drives the recording farm
├── failure-hunting-agenda.md   outstanding mining work + measured findings
└── session-mining-log.md       durable log of mining passes and fixes

tmp/pool/                gitignored but PERSISTENT by decision: mined failure
                         pools + scorer reports (rebuildable via pnpm pool/score).
tmp/farm/                disposable farm worktrees, created/removed per batch.
```

### Scripts

| Command                        | Script                        | What it does                                                                                                                                                 |
| ------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm pool`                    | `build-failure-pool.mjs`      | Mines ALL session scopes into a failure-pool JSON: every reconstructable failing edit call + its file snapshot. Input for scoring.                           |
| `pnpm score`                   | `score-chain.mjs`             | Runs the PRODUCTION pipeline over every pool entry; reports outcomes, pass attribution, drift metrics, timing. Tells us which chain passes earn their place. |
| `pnpm baseline`                | `snapshot-baseline.mjs`       | Pins today's numbers (pool/live/session) into `docs/baselines/<date>/`. Run before/after notable changes.                                                    |
| `pnpm replay`                  | `replay-session-fixtures.mjs` | Old corpus gate: replays 44 fixtures, compares builtin baseline errors vs ours (currently 36 -> 23, 13 improved, 0 regressed).                               |
| `pnpm replay:live`             | `replay-live-failures.mjs`    | Current corpus gate: replays live-failures.json, classifies outcomes against category promises. **Must report 0 unexpected.**                                |
| `extract-live-failures.mjs`    | (jiti direct)                 | Mines session JSONLs -> live-failures.json. Merge-aware: never clobbers other entries or curated fields. `--sessions <path                                   | dir>` to point at new material. |
| `extract-session-fixtures.mjs` | (jiti direct)                 | Older extractor: `sessions/*.jsonl` -> session-failures.json. Superseded by the above but kept for the old corpus' provenance.                               |

The improvement story these feed: mined real failures drive fixes -> fixes get
proven via corpus replays (0 unexpected, regressions impossible) -> deltas get
pinned as dated baselines.

</details>

---

## Attribution

Built on the work of:

- **[pi-semantic-edit](https://github.com/k3-2o/pi-semantic-edit)** - domain engine (fuzzy matching, edit resolution, apply, stale-read, closest-candidate). MIT.
- **[pi-repair-layer](https://github.com/r3b1s/pi-repair-layer)** - repair pipeline (validate-then-repair, envelope recovery, schema-guided rules). MIT.
- **[pi-deepseek-optimized](https://github.com/jrimmer/pi-deepseek-optimized)** - stormbreaker (error enhancement, loop breaking). MIT.
- **[pich / pi-toolcall-guard](https://github.com/JimmyC7834/pich)** - path preflight (normalize, block, suggest). MIT.
- **[pi-tool-repair](https://github.com/monotykamary/pi-tool-repair)** - field alias tables and repair rules. MIT.
- **[decorated-pi](https://github.com/lcwecker/decorated-pi)** - raw-splice byte preservation. MIT.
- **[pi-lens](https://github.com/apmantza/pi-lens)** - indentation autopatch and indent retargeting (ported verbatim). MIT.
- **[OpenDev / identedit](https://github.com/opendev-to/opendev)** - match-pass concepts, similarity scoring, candidate previews. MIT.

All upstream code was copied verbatim, then adapted and stripped to fit this extension's scope. No runtime dependencies on upstream packages - all copied code lives in `src/core/`.

## License

MIT. See [LICENSE](LICENSE) for details.
