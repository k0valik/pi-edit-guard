---
name: edit-failure-hunting
description: >-
  Hunt real-world "edit" tool failures inside pi session JSONL files,
  classify them against the edit-guard repair pipeline (argument repair +
  13-pass fuzzy matching), extract sanitized repro fixtures, and PROVE the
  fix end-to-end. Use when adding new failure-mode repairs to
  pi-better-toolcalls, auditing whether the extension solves observed model
  errors, mining current or very old sessions for edit failures, or
  extending live-failures.json / session-failures.json fixtures.
---

# Edit Failure Hunting

Find what models ACTUALLY get wrong when calling `edit`; decide whether it is
deterministically and safely repairable; capture a sanitized fixture; make the
pipeline fix it; prove it with replay tests. One iteration of this loop =
one testable change.

> Ground truth rule: every new repair must trace back to at least one real
> observed failure (or an exact synthetic generalization of one, clearly
> labeled). No speculative repairs.

## 1. The Loop

1. **Hunt** — scan session JSONLs for failing `edit` calls (§4).
2. **Classify** — map each failure onto the pipeline stage that should own it
   (§2, §3). Ask: is this deterministic? Is the correct behavior unambiguous?
   Can we fail closed?
3. **Extract** — pull args + pre-edit file snapshot into a sanitized fixture
   via `scripts/extract-live-failures.mjs` (§5).
4. **Implement** — argument-level: preprocessor in `src/core/prepare-arguments.ts`;
   matching-level: `src/core/edit/` (editor/apply/errors).
5. **Prove** — unit tests + `src/__tests__/integration/live-failures-replay.test.ts`
   style replay through `prepareEditArguments` -> `Value.Check(EDIT_SCHEMA)` ->
   `executeFile` (§6).

## 2. Where the Pipeline Owns What

| Stage                        | File                                                    | Handles                                                                                                                                                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Envelope decode / truncation | `src/core/repair/envelope.ts`                           | JSON-stringified root args, truncated objects                                                                                                                                                                                                                                |
| Argument preprocessors       | `src/core/prepare-arguments.ts` (`PREPROCESSORS`)       | stringified `edits`, empty-string AND empty-object entries, field aliases, nested-path hoist, oldText-only deletion inference, flat-fold                                                                                                                                     |
| Schema repair engine         | `src/core/repair/repair-engine.ts`                      | alias rename, null-drop, wrap-bare-string, retry message                                                                                                                                                                                                                     |
| Unrepairable enrichment      | `describeUnrepairableEditInput` in prepare-arguments.ts | targeted guidance appended to validation errors (nested-path conflict, bad JSON string)                                                                                                                                                                                      |
| 14-pass matching chain       | `src/core/edit/passes.ts` (`REPLACER_CHAIN`)            | simple -> line_trimmed -> whitespace_normalized -> indentation_flexible -> escape_normalized -> unicode_normalized -> block_anchor -> block_anchor_levenshtein -> fuzzy_boundary -> trimmed_boundary -> context_aware -> robust_trimmed -> robust_backslash -> token_overlap |
| Per-block orchestration      | `src/core/edit/editor.ts` (`resolveBlocks`)             | anchor windows ±10 lines, redundant-anchor drop, already-applied detection, auto-expand, two-pass shift recovery                                                                                                                                                             |
| Apply                        | `src/core/edit/apply.ts`                                | bottom-up splice, overlap/no-op/invariant classification                                                                                                                                                                                                                     |
| Errors                       | `src/core/edit/errors.ts`                               | pure message builders (kinds in `types.ts` EditErrorKind)                                                                                                                                                                                                                    |
| Telemetry                    | `src/core/telemetry.ts`                                 | CLOSED union of event types + counters — add new events here or typecheck fails                                                                                                                                                                                              |

Ordering law learned the hard way: escape-repair BEFORE punctuation cleanup.
A dropped "dangling fragment" may be legitimate string content once a missing
backslash restores the intended string boundary (`lenientParseAttempts` order
in prepare-arguments.ts encodes this — do not reorder casually).

Native parity boundary: `applyNativeCompatibility` (runs when
`repairEnabled=false`) intentionally keeps only parse-stringified-edits +
empty-filter + flat-fold. Extra tolerance there is acceptable; regressions vs
native are not.

## 3. Confirmed In-The-Wild Failure Modes

All four below were found in sessions from 2026-08-23 and are covered by
tests + fixtures on this branch.

### P1 — `path` nested inside `edits[]` (deepseek-v4-pro)

- Shape: `{"edits":[{"oldText":...,"newText":...,"path":"pkg/file.ts"}]}` — no root `path`.
- Native error: `(root): must have required properties path`.
- Evidence: 15 failed calls in ONE session (pi-utils scope); model self-healed
  each time by hoisting on retry ("top"/"root" language in its thinking).
- Fix: `hoistNestedPath` structural preprocessor — hoist when all nested paths
  agree (absent values don't block); FAIL CLOSED with a split-it hint
  (`describeUnrepairableEditInput`) when they disagree.
- Also: `/edits/*/path` alias preprocessor (file_path/filePath/target_file/file).

### P2 — malformed double-encoded JSON `edits` string (stepfun step-3.7-flash)

- Shapes seen: trailing comma before closer; dangling `,", "` before closer;
  under-escaped quote making the string close early (`ts"],"}]`).
- Native error was just `/edits: must be array` — model retried BYTE-IDENTICAL
  args because nothing told it the problem was parseable corruption.
- Fix: `lenientParseAttempts` chain (raw / newline-fix / under-escape /
  punctuation / punct+under-escape), each gated by full `JSON.parse`;
  plus enriched unrepairable message carrying the actual SyntaxError text.
- Key insight: error messages must name the REAL problem or models repeat
  themselves verbatim.

### P3 — "already applied" misreported as no-op/not-found (stepfun)

- Scenario: earlier retry applied the edit; a later identical call's SEARCH
  text no longer exists but REPLACE text does. A fuzzy pass (block_anchor
  matches on first/last lines) then hits the NEW state and post-splice apply
  reports generic `Edit results in no change`.
- Fix, two layers:
  - resolve level (editor.ts `!match` branch): REPLACE present verbatim
    (>=16 chars normalized) & SEARCH absent -> `already-applied` error kind.
  - apply level (apply.ts no-op branch): no-op where `passName !== "simple"`
    AND oldText != replacement -> reason prefix `already applied:`,
    mapped by `failureToError` to `alreadyAppliedError`.

### P4 — redundant/hallucinated anchor (stepfun)

- Evidence: anchor byte-identical to oldText (similarity 1.0), sometimes with
  hallucinated regex `/i` flags; anchor-not-found aborted the edit even when
  oldText alone would match.
- Pre-existing near-miss fallback rescues sim > 0.7 candidates from file
  content, which masks many cases — redundancy check runs FIRST: if anchor
  fails to match AND similarity(anchor, oldText) >= 0.9, drop the anchor,
  set `diag.anchorRedundant`, record `anchor.redundant_dropped`.
- If anchor == oldText and NEITHER is in the file you now get plain not-found
  with closest-candidate info instead of misleading anchor framing.

### P5 — chimera recall: oldText conflates two sibling regions (mined 2026-08-16 storm, shipped 2026-08-25)

- Shape: oldText mixes REAL lines from one region with hallucinated
  scaffolding from a neighboring lookalike (e.g. title+comment from test A,
  body plumbing from test B). Similarity to any real region ~65-76%; every
  boundary pass fails; models retry the same call with rotating anchors
  (5x observed) and burn the whole budget.
- Fix: `token_overlap` pass (dead last in chain, searchOnly) — Sørensen-Dice
  over token multisets >= TOKEN_DICE_MIN (0.65) AND lev-similarity >=
  TOKEN_LEV_FLOOR (0.45), unique non-overlapping qualifying window or null.
  Sliding-window token multisets keep it affordable; budget guard refuses
  pathological file x query shapes.
- Semantic placements surface `[SEMANTIC MATCH] ... at lines X-Y` warnings
  (result text + details.semanticWarnings + toggleable ctx.ui.notify).
- Fixture: `chimera-recall-edit-engine-dup-lines` (category
  `chimera-recall-drift`); two former gone-diagnostic fixtures proved genuine
  rescues and were reclassified to `oldera-drifted-recovered`.

### Self-documenting failures (2026-08-25+)

Not-found / anchor-not-found diagnostics now carry dice+jaccard against the
shown candidate and an explicit `Anchor status:` line. High dice with low
line-similarity = reorder/hallucination signature. NEW sessions are therefore
self-mining: grep session JSONLs for `dice 0.` and `Anchor status:` instead of
reconstructing drift by hand. Envelopes carry `outcome: applied|partial|failed`
(counts/line ranges only — never content strings).

### Historical oddity

`[PARTIAL APPLY] Applied 19 of 4 edits` style numerator/denominator nonsense
was reported fixed on this branch; re-check if it resurfaces in replays.

### Old-era corpus (native-tool sessions, 2026-04..2026-06) — mined 2026-08-24

Scan of 60d+ sessions (pool builder: `scripts/build-failure-pool.mjs --out tmp/pool/pool-v2.json`,
extractor
`scripts/extract-old-era-fixtures.mjs`, replay in live-failures-replay.test.ts
`oldera-*` categories):

- 755 failing native edit calls with reconstructed snapshots. Native applied
  NONE of them; our pipeline fully applies 368 (49%), including 212 whose
  SEARCH text had NO verbatim occurrence (pure fuzzy recovery).
- New rules shipped from it: `dropEmptyEditObjects` (~90 wild calls with `{}`
  placeholders) and `inferDeletionMissingNewText` (~50 oldText-only calls,
  interpreted as deletions; newText-only stays fail-closed).
- Era filters that MUST stay: ROBUST_EDIT was a FALLBACK tool, not an edit
  override — its rescue pairs are interesting but hashline-schema failures it
  rescued are not; exclude `range.*must match pattern`, `[E_ASYMMETRIC_SHIFT]`,
  `[E_LINE_CONTENT_MISMATCH]`, `[E_REPLACE_TEXT_*]`, `[E_BAD_REF]`,
  "BLOCKED - Edit without read", "retried by matching content by text search".
- Reconstruction = last successful `read` toolResult per path + replaying
  fully-successful native edits on top. Files only viewed via bash
  (`sed -n`, `cat`) have NO snapshot -> those calls are unextractable.

### Known gaps (for the planned full audit pass)

- Existing passes/heuristics were assembled from assumptions + ported code;
  none have been systematically validated against a curated corpus. Build the
  corpus first (old-session mining!), then score every pass/rule against it.
- 4 extracted failures were dropped for missing snapshots (files never read
  in-session before the failed call): deepseek-pi-utils lines 82/119/365,
  stepfun line 1363 (anchor case). Recover by reconstructing files from git
  history of the target repos if needed.
- Per-model shape stats are thin: deepseek-v4-pro and step-3.7-flash fail
  differently. Mine more sessions before tuning thresholds (0.9 anchor sim,
  16-char already-applied floor are first guesses, not laws).
- PERF HOTSPOT (measured on 755-call corpus, see issue #28): APPLIED calls
  are fast (median 3ms, p95 ~0.9s) — the cost lives in the NOT-FOUND path,
  where all passes run to completion + closest-candidate/auto-expand rescan.
  Error-path max observed: 42s on one call; 6 slowest calls = ~125s of the
  corpus's ~264s total. Fast-path ideas ranked in issue #28 comment.
  Repro fixtures: old-era-20-15-18-68 (drifted 735-char SEARCH), corpus
  indices 664/476/312.
- `execute-file.ts` defaults injected fs ops to REAL `node:fs`
  (`opts.readFile ?? readFileSync`). Tests are safe only because every replay
  harness injects InMemoryFS — keep it that way, or add a path guard.
- ~200 drifted not-found calls get closest-candidate diagnostics but no
  repair — the fuzzy chain's residual. Sample: oldera-gone-diagnostic.
- PASS-ORDER AUDIT (side finding, 2026-08-24): the chain is NOT a strict
  determinism gradient. `block_anchor_levenshtein` (#4, middle sim >=0.3)
  outranks deterministic normalizations (#6-8); `unicode_normalized` is a
  deterministic transform buried under heuristics (#9-11). Do NOT reorder by
  taste: short-circuiting means order changes match attribution everywhere.
  Instead A/B candidate orderings against the corpus + fixtures (§7).
- ANCHOR vs SEARCH scope: heuristic passes can be marked `searchOnly: true`
  in REPLACER_CHAIN; anchor lookups pass `{ allowSearchOnly: false }`
  (editor.ts pre-check/primary/fallback). Fuzz-finding anchors silently
  re-anchors edits to wrong-but-similar regions and defeats the
  redundant-anchor guard — keep new fuzzy passes searchOnly unless proven.
- Wrong-file failures (13 corpus cases): oldText exists verbatim in ANOTHER
  file read earlier in the session. Deterministic salvage = enriched error
  hint ("found in <other path>"), needs session-read context at the hook/tool
  layer, not in core executeFile. Not yet implemented.

## 4. Hunting Playbook (session JSONL)

Sessions live under `~/.pi/agent/sessions/<scope>/<timestamp>_<uuid>.jsonl`.
Scope dirs encode absolute cwd with `/`->`-` wrapped in `--`. NEVER read live
files in place without a plan; prefer copying candidates to `tmp/sessions/`
(gitignored) first. `.exit.jsonl` files and `.trash/` are skip-listed.

Fast cross-scope scan (edit errors per file, last N days, with model
attribution via `model_change` entries):

```bash
python3 - <<'EOF'
import json, glob, os, time
cutoff = time.time() - 5*86400   # days back
rows = []
for f in glob.glob(os.path.expanduser('~/.pi/agent/sessions/*/*.jsonl')):
    if os.path.getmtime(f) < cutoff or f.endswith('.exit.jsonl'): continue
    edits = errs = 0; cur='?'; models=set()
    for line in open(f, encoding='utf-8', errors='replace'):
        if '"toolName"' not in line and 'model_change' not in line: continue
        try: e = json.loads(line)
        except: continue
        if e.get('type')=='model_change':
            cur=f"{e.get('provider','')}/{e.get('modelId','')}"; models.add(cur)
        m=e.get('message',{})
        if e.get('type')=='message' and m.get('role')=='toolResult' \
           and m.get('toolName')=='edit':
            edits+=1
            if m.get('isError'): errs+=1
    if edits: rows.append((errs,edits,','.join(sorted(models)),f))
rows.sort(reverse=True)
for r in rows[:25]: print(r[:3], os.path.basename(r[3])[:36])
EOF
```

Then drill into a candidate: pair each assistant `toolCall` block
(`type=="toolCall", name=="edit"` inside `message.content[]`) with its
`toolResult` message entry via `toolCallId`. For failures, dump
`arguments` keys + shapes, result text, and surrounding `thinking` blocks
(thinking explains what the model BELIEVED went wrong — gold for repair design).

Error-signature grep starters:

```bash
S=tmp/sessions/<file>.jsonl
grep -c 'Invalid input for tool .edit.' $S     # schema validation
grep -c 'must have required propert' $S        # missing fields
grep -c 'SEARCH text not found' $S             # match failures
grep -c 'results in no change' $S              # noop confusion
grep -c 'anchor not found' $S                  # anchor failures
```

Hard-won pitfalls:

- The pi TUI renders paths as markdown: `src/__tests__/x.ts` DISPLAYS as
  `src/tests/x.ts` (underscores eaten). Never grep sessions for the displayed
  spelling; reconstruct the real path first.
- User-pasted TUI output inside a `user` message is NOT that session's ground
  truth — the actual failing calls usually live in an EARLIER session. Find
  real toolCall/toolResult pairs before analyzing.
- Pool/scorer tooling (2026-08-25): `pnpm pool -- --out tmp/pool/pool-v2.json`
  rebuilds the failure pool from ALL scopes (era filters + verbatim-splice
  reconstruction; fuzzy-broken chains drop the entry, never poison it).
  `pnpm score -- --pool tmp/pool/pool-v2.json [--sample N] [--offset N]` runs
  the production pipeline per entry and reports outcome classes, pass
  attribution, drift metrics (lev + dice + jaccard), CANDIDATE classification,
  slowest entries. Artifacts under repo `tmp/pool/` are PERSISTENT — user
  keeps them deliberately; do not delete, rebuild with new names instead.
- Heavy entries hang single-process scorers on the not-found hotspot (one
  pool entry took 947s). Run full scores via `nohup … &`, poll the log, rely
  on the script's 25-entry checkpoints; never pipe a foreground run through
  `tail` — a kill swallows everything buffered.
- Pre-push runs FULL typecheck: local test edits with loose casts
  (`x as typeof Y`) can pass fmt/lint and still fail the push late.
- `args.get('path','')` LIES when the key is MISSING (prints ''). Check
  `'path' not in args` explicitly. This hid P1 initially.
- Pre-edit snapshots contain oldText but NEVER newText — using newText as a
  reconstruction/window needle silently yields wrong or empty snapshots.
- Model attribution: attribute calls to the most recent preceding
  `model_change` entry, not file mtime guesses.
- isError=true covers schema errors; match failures may be isError with rich
  text, and PARTIAL APPLY results are isError=false — scan text, not flags.
- vitest swallows console.log in some reporters; write debug output to a file.
- `timeout`-killed vitest runs LEAK their fork-pool workers: if a test spins
  in a synchronous infinite loop, test-timeouts cannot fire (same thread) and
  killing the CLI orphans the children at 100% CPU indefinitely. Cleanup:
  `pkill -9 -f 'workers/[f]orks.js'` (bracket trick keeps the pattern from
  matching the invoking command itself). Verify with
  `ps aux | grep -c '[f]orks.js'`.
- Do NOT import project modules via `npx tsx` outside vitest:
  `@earendil-works/pi-coding-agent` has no export map entry for direct node
  resolution. Run scratch logic AS a vitest test.
- Block comments containing globs (`src/**/*.ts`) terminate early on the `*/`
  inside the glob. Use line comments for anything with `*`+`/`.

## 5. Extraction & Sanitization

```bash
cp <live-session>.jsonl tmp/sessions/<name>.jsonl     # NEVER mutate originals
# register the copy in SESSIONS inside the script, then:
node scripts/extract-live-failures.mjs
# -> src/__tests__/integration/fixtures/live-failures.json
```

The script pairs failing edit calls with prior `read` snapshots, categorizes
(`validation-nested-path`, `validation-edits-string`, `already-applied-noop`,
`anchor-not-found`, `not-found`), dedupes, and sanitizes:

- repo-relative paths only (strip `/home/<user>/projects/<repo>/`, `./`);
- scrub usernames everywhere INCLUDING expectedFailureText echoes;
- window file content around target needles (80-line pad);
- drop fixtures without usable snapshots (printed, count them);
- `already-applied-noop` single-edit full-file cases may use
  `fileContentSynthetic: true` (newText IS the file).

Fixture schema additions vs legacy session-failures.json: `rawEditsString`
(verbatim corrupt string), `fileContentSynthetic`, `fileContentTrimmed`,
`expectedFailureText` (original error, scrubbed), `source.callLine/resultLine`.

Legacy corpus: `fixtures/session-failures.json` (synthetic recorded sessions,
extracted by `scripts/extract-session-fixtures.mjs`, replayed negative-control
style by `src/__tests__/integration/replay-session-fixtures.test.ts`). Keep
both corpora; their assertion contracts are OPPOSITE (legacy: recorded errors
must stay errors; live: repairs must turn them into applies).

## 6. Proof Strategy

Unit (fast, deterministic):

- `src/__tests__/wild-repairs.test.ts` — hoist agree/disagree/alias,
  punctuation + under-escape repairs, unrepairable hints.
- `src/__tests__/wild-diagnostics.test.ts` — already-applied (resolve + apply
  layers), redundant-anchor drop + negatives.

Integration (the proof):

- `src/__tests__/integration/live-failures-replay.test.ts` — rebuilds the
  EXACT raw arg shape the model sent, asserts strict schema REJECTS it,
  runs `prepareEditArguments`, asserts schema ACCEPTS the repaired form,
  then executes against the reconstructed snapshot and asserts outcome.

Commands: `pnpm typecheck && pnpm lint && pnpm test` (pnpm ONLY, never
npm/npx/yarn). New telemetry event types MUST be added to the union + counter

- summary in `src/core/telemetry.ts` or typecheck fails.

## 7. Next Full-Pass Agenda (agreed direction)

1. Curate corpus: mine OLD sessions across all scopes for edit failures;
   merge into both fixture files with provenance.
2. Score the existing 13 passes + every repair rule against the corpus;
   delete/adjust heuristics that never fire or misfire (they were built on
   assumptions).
3. Define per-category acceptance criteria BEFORE implementing more fixes;
   a fixture proves a fix only if the replay asserts final file bytes.
4. Track per-model failure fingerprints (provider/modelId alongside source)
   so threshold tuning is data-driven.
5. Upgrade the LEGACY corpus (session-failures.json) from negative-control
   replays to the same prove-the-fix contract where a repair applies:
   for each legacy fixture ask "SHOULD our pipeline fix this?" — if yes,
   assert `prepareEditArguments` -> schema-valid -> `executeFile` success;
   if genuinely unrepairable (invented text, stale context), assert the
   enriched error instead. Classify every fixture into one of those two
   buckets; no fixture may remain unclassified.
