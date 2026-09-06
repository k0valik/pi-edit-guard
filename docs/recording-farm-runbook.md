# Recording Farm Runbook

Orchestrator-facing guide for running the fixture recording farm. The tested
agents never see this file. Their world is `fixtures/files/missions/` only.

## Purpose

Produce real edit failures under naturalistic conditions, extract them as
fixtures, and measure pipeline improvement against pinned baselines
(`docs/baselines/`). The failure generator is deliberately weak models doing
plausible work badly — never models told to fail. **Any hint of "you are
testing the edit tool" in an agent's context contaminates the batch.**

## Topology

```
main agent (orchestrator, runs this runbook)
├── slot L  — edit-tester agent def, local llama.cpp model, ONE at a time
└── slots A1..A3 — same agent def, stepfun/step-3.7-flash via API, parallel
```

- Same mission set for every slot (controlled backend comparison).
- The Q4/Q1-class local model is the high-yield generator; API slots add a
  stronger-model failure distribution (semantic drift, chimera recall) that
  weak models rarely produce.
- Batch = one full pass of `missions/WORK-QUEUE.md` per slot.

## Worktree lifecycle

Per slot, per batch:

```sh
git worktree add tmp/farm/<run-id>-<slot> -b farm/<run-id>-<slot>
# pi session starts with cwd = that worktree; extension + fixtures travel
# with the checkout
git worktree remove --force tmp/farm/<run-id>-<slot>   # after extraction
git branch -D farm/<run-id>-<slot>
```

The orchestrator owns all worktree git operations. Agents inside a worktree
never branch, commit, or push.

## Iteration protocol

1. Spawn the agent with: house rules path + **the entire work queue** +
   "work from the repo root you are given". One agent works ALL tickets
   top-to-bottom in ONE session — never split into per-ticket spawns.
   Small scopes cause early exits and fresh-context sharpness that real
   work never has; the attention tail across 22 files IS the experiment.
2. Let it work undisturbed. Do not steer mid-queue; struggle is data.
3. When it reports done: verify restoration —
   `git -C <worktree> status --porcelain`.
   - **Empty** → clean iteration; proceed.
   - **Dirty** → do NOT fix it silently. Record which files, diff shape,
     and whether undo was skipped or failed. This is either an undo-tool bug
     (extract as a candidate fixture — new category) or misconduct signal
     (note in batch log). Then reset the tree yourself before the next
     iteration.
4. Copy the session JSONL out of the global session store into the repo,
   TRACKED (raw sessions are re-mineable corpus — never gitignore them):
   ```sh
   # pi writes to ~/.pi/agent/sessions/<cwd-scope>/<session-id>.jsonl;
   # each worktree cwd creates its own scope dir. The orchestrator knows
   # which session ids it spawned.
   cp ~/.pi/agent/sessions/<scope>/<session-id>.jsonl \
      src/__tests__/integration/fixtures/farm-sessions/<run-id>-<slot>.jsonl
   ```

## Extraction

```sh
pnpm exec jiti scripts/extract-live-failures.mjs --sessions \
  src/__tests__/integration/fixtures/farm-sessions/<run-id>-L.jsonl \
  src/__tests__/integration/fixtures/farm-sessions/<run-id>-A*.jsonl
```

`--sessions <path|dir>...` overrides the hardcoded default list; directories
expand to their `*.jsonl` children. Names derive from filenames, so keep the
`<run-id>-<slot>` naming. The merger is field-preserving: curated fixture
overrides (`expectApplied`, `expectPattern`, `_note`) survive regeneration,
and entries from OTHER sessions/runs are left verbatim.

- Provenance per fixture: run-id + slot backend must land in the `source`
  field so corpus analysis can split local-vs-API failure distributions.
- New failure shapes → new categories in `live-failures.json`; candidates:
  undo-residue (dirty-tree cases), creation-mismatch (new-file edits),
  multi-file attention drift.
- Re-run `pnpm replay:live` after each merge into the corpus; the corpus
  gate is **0 unexpected**.

## Baselines and reporting

After every batch that changes the corpus or the pipeline:

```sh
pnpm baseline            # snapshots pool/live/session numbers for today
```

Headline metrics accumulate across batches: extracted-failures-per-session,
rescue-rate delta vs the previous baseline, restore-clean rate per backend.
These are the README numbers — keep them honest and dated.

## Friction map (orchestrator-only)

Expected failure surfaces per ticket, from MANIFEST.json. Use to pick
batches and correlate extractions; never paste into briefs.

| Ticket        | Primary surfaces                                            |
| ------------- | ----------------------------------------------------------- |
| 1 docs        | fuzzy header match, numbered-block insertion, TOC drift     |
| 2 style       | mixed tab/space, cross-file rename sync                     |
| 3 processor   | rename-with-compat, signature change, base-class edit       |
| 4 encoding    | BOM, latin1 bytes, CRLF→LF whole-file                       |
| 5 dedup       | duplicate blocks, ambiguous anchors, near-identical regions |
| 6 strings     | very long lines, template↔concat conversion                 |
| 7 config      | strict parser style, nested JSON paths                      |
| 8 archaeology | commented-code revival, overlapping targets                 |
| 9 whitespace  | three-file sweep (attention tail), noop-adjacent edits      |
| 10 mixed bag  | regex literals, quoting conventions, unicode, noop edits    |

Ticket 10 is the attention-tail batch — expect the worst failures late in
the list. Ticket 5 is the ambiguity-heavy batch — best single-ticket yield.

## Hygiene rules

- Farm branches and worktrees are disposable; nothing from `farm/*` merges
  anywhere. Only extracted fixtures enter the repo (as corpus commits).
- Fixture files in `fixtures/files/` are committed truth; the orchestrator
  resets worktrees between iterations, agents never see a dirty start.
- If a session crashes mid-batch: salvage partial state per the
  subagent-orchestration skill (audit disk, relaunch with corrected brief).
- Keep batch logs append-only in `tmp/farm/log-<run-id>.md`: slot, ticket,
  restore-status, fixture count. Memory dies on compaction.
