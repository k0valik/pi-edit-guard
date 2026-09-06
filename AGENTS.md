# Edit Guard

pi extension that overrides the built-in `edit` tool with argument repair, 13-pass fuzzy matching, anchor-scoped search, byte-preserving writes, stale-read protection, path preflight, stormbreaker loop-breaking, telemetry, undo, and write guard. One prompt surface — the model calls `edit` exactly as before.

Shared infrastructure lives in `packages/pi-base/` — use it, don't reimplement it.

This is a git repository:

- No hardcoding of usernames, real directory paths
- Tests should be reproducible on a fresh clone and piped into OS temp dir instead of mutating git state, even for fixtures.

---

## Commands

| Check     | Command          |
| --------- | ---------------- |
| Full gate | `pnpm check`     |
| Typecheck | `pnpm typecheck` |
| Lint      | `pnpm lint`      |
| Format    | `pnpm fmt`       |
| Test      | `pnpm test`      |

After any change: `pnpm typecheck && pnpm lint`.

---

## Rules

1. **No handrolling.** If pi or `@k0valik/pi-base` exports it, use it.
2. **Copy verbatim, never rewrite from memory.** Upstream source is ground truth.
3. **One commit = one testable change.**

---

## What This Extension Registers

### Tools

| Tool   | Description                                                                                                                                                                                                                                                                                                            |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `edit` | Overrides the built-in `edit` tool. Runs argument repair, 12-pass fuzzy matching, anchor-scoped search, auto-expand, byte-preserving atomic writes, stale-read protection, path preflight, and enriched failures. Registered under the built-in name — extension tools win by name. Killswitch: `editOverrideEnabled`. |
| `undo` | Reverts the most recent edit made by the `edit` tool on a file. Uses an append-only JSONL undo dump that survives sessions (last record per file wins), bounded by FIFO eviction at `undoMaxBytes`. Gated by `undoEnabled`.                                                                                            |

### Commands

| Command              | Description                                          |
| -------------------- | ---------------------------------------------------- |
| `/edit-guard`        | Show status: config, stormbreaker stats, audit trail |
| `/edit-guard:config` | Open settings modal (global / project tabs)          |

### Hooks

| Hook                  | Description                                                                                                                                                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stormbreaker`        | Enhances cryptic tool errors into actionable diagnostics; breaks failure loops via a per-tool sliding window (last 10 failures, threshold default 3).                                                                                         |
| `stale-read-observer` | Tracks file mtime on every `read`; blocks `edit`/`write` if the file changed since the last read. Self-heals after the agent's own successful edit/write.                                                                                     |
| `preflight`           | Normalizes paths in-place (strips quotes/whitespace, resolves relative to cwd); blocks non-existent paths with near-match suggestions. Covers read/edit/write/ls/grep/find.                                                                   |
| `overwrite-guard`     | **Off by default.** When enabled, blocks the first `write` to an existing non-empty file per session with a nudge toward `edit`; the second attempt passes. Useful for small local models that silently drop code by overwriting from memory. |

---

## Packaging

- **Type:** ESM (`"type": "module"`)
- **Main entry:** `dist/index.js` (prebuilt; `src/extension.ts` is the dev/jiti fallback)
- **Backward-compat entry:** `extension.ts` (re-exports `src/extension.ts` for existing `pi.extensions` entries)
- **Build:** `tsup` bundles to `dist/` (ESM, tree-shaken, external pi deps)
- **Workspace:** `pnpm-workspace.yaml` allows native builds for `@google/genai`, `esbuild`, `protobufjs`, and `simple-git-hooks`
- **Dependencies:** No runtime dependencies. pi packages are optional peer dependencies.
- **Published as:** Private (`"private": true`) — installed from git

---

## Tests

- Unit tests live in `src/__tests__/` (non-integration) and `src/__tests__/integration/` (session replay + fixtures)
- Integration fixtures: `src/__tests__/integration/fixtures/` (files, sessions, failures)
- Test runner: vitest (two projects: `pi-extension-template` for `src/`, `pi-base` for `packages/pi-base/`)
- Timeout: 15s default; integration replay tests may need longer

---
