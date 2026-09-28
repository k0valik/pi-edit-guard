# Match-pipeline perf hotspots — noticed, fixed, confirmed

## What we noticed (2026-09-28, pool re-score)

Two pool entries dominated the scoring run's wall time:

| Entry | Query              | File              | Time      | Outcome                        |
| ----- | ------------------ | ----------------- | --------- | ------------------------------ |
| #832  | 6.2 KB / 219 lines | 17 KB / 544 lines | **218 s** | full-apply via `token_overlap` |
| #754  | 6.3 KB / 198 lines | 18 KB / 530 lines | **161 s** | error (full scan, no hit)      |

Per-pass timing on the same inputs showed every other pass at 0–53 ms;
`tokenOverlapFind` alone cost 216 s / 161 s. Together the two entries
accounted for ~6 of the run's ~9 minutes. (The LCS-DP cost had been
noticed before — this pinned it to a pass and an input shape.)

## Root cause

`tokenOverlapFind` collects every window with token-dice ≥ 0.65, then runs
the full O(m·n) LCS DP (`similarity()`) on each to confirm the lev floor.
Dice is cheap but indiscriminate on repetitive files: the 6 KB query
qualified ~150 windows at ~36 M LCS cells each in pure-JS DP. The only
budget guard covered window _evaluations_, not DP _cells_.

## What we fixed

- `TOKEN_DP_BUDGET_CELLS = 100_000_000` in `src/edit/matching/passes.ts`
  (precedent: `BLOCK_ANCHOR_BUDGET_CELLS`). Qualifiers are confirmed
  dice-desc so the best candidate still goes first; exhaustion returns
  `null` (fail-closed) instead of hanging the edit. A minutes-long match
  is a de-facto production timeout — the model gets a not-found
  diagnostic with near-miss guidance instead of silence.
- The pass already runs dead last in `REPLACER_CHAIN` (`searchOnly`), so
  no reordering was needed: every cheaper reading still gets first shot,
  and the budget is the backstop for the expensive fallback.
- Regression test in `tests/token-overlap-pass.test.ts`: synthetic
  repetitive 400-line file / 150-line query must return `null` fast;
  the small-file rescue, ambiguity, and dice-floor tests are untouched.

## Confirmation (re-run, same inputs)

| Entry | Before         | After          | Outcome change                           |
| ----- | -------------- | -------------- | ---------------------------------------- |
| #832  | 218 s, applied | 0.3 s, refused | full-apply → partial (fast, diagnosable) |
| #754  | 161 s, error   | 0.3 s, error   | none (just fast)                         |

Full pool re-score max entry time: 218 s → 8.3 s. Zero of the 67
`blind-failure` entries are budget-shaped (query × file ≤ 100 M cells),
so the budget caused no recall loss there; pass attribution vs the
2026-08-26 baseline is stable (`context_aware` 26 → 17 is the intended
duplicate-import refusal working).

## Still open (no re-profile needed)

- Residual ~4–8 s `partial` entries (#578/#579/#941 shape): failure-path
  diagnostics (`findClosestCandidate`, near-miss alternatives) on large
  inputs. Same LCS-DP family, smaller magnitude. Next step if they matter:
  cell-budget the diagnostic scans the same way.
- `blockAnchorLevenshteinFind` has no DP budget guard (per-line DPs).
  Measured 0–1 ms on the shapes above, but a hostile input (many boundary
  pairs × long middles) could repeat this class. Candidate for the same
  treatment.
- `lcsLength` itself is naive O(m·n) JS. A faster core (bit-parallel,
  early-exit) would lower every budget's wall-time, but budgets — not
  speed — are what bound the worst case.
