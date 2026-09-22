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
