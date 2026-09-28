# Changelog

## Unreleased

### Fixed

- `edit`: refuse matches that graft onto externally drifted lines instead of
  silently overwriting the drift (pi-edit-benchmark `b10-duplicate-drift`,
  `b9-boundary-changed`, `insert-race-stale-boundary`):
  - `trimmed_boundary` / `context_aware` boundary anchors now require
    trimmed-line equality instead of substring containment.
  - Multi-line verbatim matches (`simple`, `trimmed_boundary`, `escape_normalized`)
    must now cover whole lines (line-alignment law). Single-line substring
    semantics are unchanged (`sub-line-token`, `replace-all` depend on them);
    single-token grafts remain the stale-read hook's job.
- `edit`: allow empty `oldText` to seed a genuinely empty file
  (benchmark `empty-file`). Non-empty files keep the validation error.
- stale-read guard: whitespace-only drift (formatter reindent/respace)
  downgrades the first-contact block to proceed-with-advisory when every
  `oldText` still resolves through a whitespace-only-tolerant match
  (Tier 1-3). Content drift keeps the hard block.
- `edit`: single-line whole-line matches widen to the line tail, so
  full-line replaces strip trailing whitespace (benchmark
  `whitespace-only`). Mid-line tokens keep substring semantics; leading
  indentation is never absorbed.
- `edit`: splice hygiene — one trailing line break in `newText` that
  duplicates the file's own separator is dropped (benchmark
  `b6-change-then-revert` blank line, `crlf-bom` LF-query corruption);
  interior bare-LF breaks conform to a CRLF span. EOL-aware `newText`
  stays verbatim.
- `edit`: refuse pure-repeat surplus matches where the query holds more
  content lines than the span but adds no novel content (benchmark
  `duplicate-import` hallucinated 4-line query no longer duplicates).
- stale-read guard: single-line safety is whole-line, not substring —
  `bbb` inside drifted `bbb-external` no longer downgrades to advisory
  (benchmark `stale-line`/`b9`/`error-guidance` grafts now block on first
  contact; re-read recovery still proceeds). Collapse/trim tolerance for
  genuine respace is unchanged.
