---
name: pi-development-workflow
description: >-
  Develop, debug, and audit pi extensions in the pi-utils monorepo.
  MUST USE when editing building, writing, creating or modifying a pi extension packages, debugging
  runtime mismatches after a code change, or auditing extensions for redundant
  reimplementations of pi utilities.
---

# pi Development Workflow

This skill is a **router** into everything we've learned about writing pi
extensions in this monorepo. Each reference below captures a specific domain
— read the relevant one before starting work that touches its area. The
inline content here (execution stages, vocabulary, rules) is the common spine
that all extensions follow.

## Three Rules

1. **Copy verbatim, never rewrite from memory.** Upstream source is ground truth.
   Adaptation is surgical rewiring, not rederivation.
2. **No handrolling.** If pi itself (upstream coding agent from earendil-works) or pi-base (internal lib/infrastructure core utilities) exports it, use it. Reimplementing tested
   utilities introduces bugs.
3. **One commit = one testable change.** Not "fixed 12 things." Not "scaffolded
   everything."

## Vocabulary

| Term                | Meaning                                                                |
| ------------------- | ---------------------------------------------------------------------- |
| **source monorepo** | `~/projects/pi-utils/` — agent edits, commits, pushes here             |
| **runtime clone**   | `~/.pi/agent/git/github.com/k0valik/pi-utils/` — pi loads from here    |
| **jiti**            | JIT compiler resolving `.js` → `.ts` in-process; caches sub-modules    |
| **handrolling**     | Reimplementing what `@earendil-works/pi-*` already exports             |
| **/reload**         | Hot-reload: re-evaluates entry point, user's new install is recompiled |
| **full restart**    | `pi --continue` or process restart; clears all jiti caches             |

## Quick Navigation

Decide what you're doing, then read the listed reference before touching code.

| You need to...                                        | Read this first                                                                                                                                                                         |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Port, lift, or graft from upstream packages           | [ingest-external-packages](../ingest-external-packages/SKILL.md) skill; [operation-taxonomy.md](../ingest-external-packages/references/operation-taxonomy.md) for operation definitions |
| Write or rewrite tool descriptions                    | [tool-description-writer] (chained skill); [references/tool-description-writing.md](references/tool-description-writing.md) for per-layer workflow                                      |
| Understand the four-layer prompt architecture         | [references/pi-system-prompt-architecture.md](references/pi-system-prompt-architecture.md)                                                                                              |
| Audit code for redundant pi/pi-base reimplementations | [references/handrolling-audit.md](references/handrolling-audit.md) — smell catalog + procedure                                                                                          |
| Build or modify config surfaces (ConfigManager)       | [references/config-modal-howto.md](references/config-modal-howto.md) — the single source of truth for ConfigManager + the settings modal toolkit                                        |
| Quick API lookup (events, TUI, state, sendMessage)    | [references/cheatsheet.md](references/cheatsheet.md)                                                                                                                                    |
| Understand event ordering / choose the right hook     | [references/session-lifecycle.md](references/session-lifecycle.md) — full sequence diagram                                                                                              |
| Build or modify any extension (general workflow)      | Stages 1-6 below                                                                                                                                                                        |

## How pi Loads Extensions

1. `~/.pi/agent/settings.json` declares packages:
   ```json
   "packages": ["git:https://github.com/k0valik/pi-utils"]
   ```
2. pi clones into `~/.pi/agent/git/github.com/k0valik/pi-utils/` and runs `pnpm install` there.
3. `pnpm install` fires the root `prepare` hook → `scripts/build-extensions.mjs` runs `tsup` for every package with a `tsup.config.ts`, emitting `packages/<pkg>/dist/`.
4. pi reads the **root** `package.json` → `pi.extensions`, which points at the compiled `dist/*.js` entries. Compiled output starts ~20% faster than jiti-compiling source.
5. Each bundle inlines `@k0valik/pi-base` (tsup `noExternal`); pi's own packages stay external.

Two loading modes coexist:

- **Root manifest → `dist/`** — what pi actually loads in the runtime clone. Changing source without rebuilding changes nothing at runtime: rebuild (`pnpm build:extensions`) or pull in the runtime clone (its `pnpm install` rebuilds).
- **Per-package `pi.extensions` → `src/*.ts`** — used when loading a single package directory directly (e.g. `pi -e packages/pi-foo`); jiti compiles on the fly. Entry naming varies per package (`src/index.ts`, `src/extension.ts`, package-root files) — inherited, cosmetic, not worth a mass rename. New packages use `src/index.ts`.

Extension-registered tools **win over built-ins by name** — both the
`promptSnippet` (system prompt) and the `description` + `parameters` (LLM tool
block) come from the extension's definition, not the built-in.

For the full API surface (ExtensionAPI, ExtensionContext, every `pi.on()` event,
state persistence, TUI interaction, sendMessage delivery modes), skim
[references/cheatsheet.md](references/cheatsheet.md).
For the complete event flow from startup through compaction with per-event
payloads, read
[references/session-lifecycle.md](references/session-lifecycle.md).
For how the four tool-description layers map to what the model sees in the
system prompt vs the LLM API tool block, read
[references/pi-system-prompt-architecture.md](references/pi-system-prompt-architecture.md).

## Upstream pi Documentation

pi ships extensive markdown docs for extension authors, written for agents to
read. **Read the docs before reading the source.** The docs are authoritative;
the source code is an implementation detail.

From the monorepo root, list them:

```bash
ls node_modules/@earendil-works/pi-coding-agent/docs/*.md
```

This resolves through pnpm's virtual store symlink — no glob needed.

Key docs for extension development:

| File                  | Covers                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| `docs/extensions.md`  | Extension API surface: events, registration, lifecycle, TUI, RPC — the single most important doc |
| `docs/tui.md`         | TUI component library: Container, Text, SelectList, etc.                                         |
| `docs/keybindings.md` | Keyboard shortcut registration via `pi.registerShortcut()`                                       |
| `docs/settings.md`    | Settings schema, settings modal, config loading                                                  |
| `docs/packages.md`    | Pi package format, publishing, `pi install`                                                      |
| `docs/sdk.md`         | SDK mode: programmatic control, headless operation                                               |
| `docs/skills.md`      | Skill system: structure, discovery, how skills load                                              |
| `docs/sessions.md`    | Session lifecycle, tree navigation, `/resume` semantics                                          |

Before implementing anything that touches events, TUI, settings, or
keybindings, read the corresponding doc. It will save you from rediscovering
what pi already documents.

## Execution Workflow

### Stage 1: Intake

Pin down before touching code:

- What does it replace / override? (built-in tool, existing extension, or net-new)
- Operation type: clone / extract / copy / lift / graft / synthesize / replace
- Upstream sources (GitHub URL, fork) or "none, write from scratch"
- Out of scope — explicit list
- Success test — one sentence: observable outcome

Quick-start template:

```
New extension: [name]
Intake:
  Replaces: [built-in edit | nothing]
  Upstream: [URLs, or "none"]
  Out of scope: [ ]
  Success test: [ ]
```

If the extension replaces a built-in tool or adds new tool descriptions, read
[references/tool-description-writing.md](references/tool-description-writing.md)
before writing descriptions — the per-layer classification workflow prevents
duplication across `description`, `promptSnippet`, `promptGuidelines`, and
parameter descriptions.

**Completion criterion:** All five questions answered. No code touched.

### Stage 2: Reconnaissance

For upstream work: `git clone --depth 1 <url> tmp/<name>-repos/`.
Never `web_fetch` a GitHub URL — the tool returns HTML, not source.

Three-pass analysis:

1. **Surface** — README, package.json, file count, recent git log
2. **Structure** — src/ layout, entry points, tool registrations
3. **Deep** — key file diffs between forks if multiple sources

For complex operations (graft, synthesize), write a brief strategy doc.
User reads and says "go" before any file operation.

For operation definitions (clone / extract / copy / lift / graft / synthesize /
replace), read
[../ingest-external-packages/references/operation-taxonomy.md](../ingest-external-packages/references/operation-taxonomy.md).

**Completion criterion:** Strategy understood. User approved (if required).

### Stage 3: Acquisition

Copy verbatim, then edit in place:

```bash
cp -r tmp/<source>/ pi-<extension>/
# edit files in place after
```

Never write files from scratch when a source exists.

Pruning: remove `.github/`, `.vscode/`, agent docs (`AGENTS.md`, `CLAUDE.md`),
lockfiles, incompatible test assets.

Wiring: `package.json` (name, deps, `pi.extensions` → `./src/index.ts`),
`tsconfig.json` (extends `../../tsconfig.json`), `vitest.config.ts` (named
`defineConfig` one-liner), `tsup.config.ts` (copy from an existing package,
adjust the entry name), root `package.json` `pi.extensions` (add the
**dist** entry, e.g. `./packages/pi-foo/dist/index.js`). `pnpm-workspace.yaml`
needs nothing — the `packages/**` glob covers new packages.

**Completion criterion:** `pnpm install` succeeds. `pnpm typecheck` passes.
Baseline tests green.

### Stage 4: Development

```bash
git checkout -b <version>-<feature-summary>
```

Per feature:

1. Write test first (if net-new)
2. Implement
3. `pnpm test` (must pass)
4. `git commit -m "feat(scope): description"`
5. `git push origin <branch>`

One commit = one testable change.

For feature lifting: read exact source lines, copy the section, adapt to local
types, write a test, run, commit.

During implementation, reference
[references/cheatsheet.md](references/cheatsheet.md) for common patterns:

- State persistence via `pi.appendEntry` + `sessionManager` recovery
- TUI interaction (notifications, dialogs, custom components, `ctx.hasUI` guards)
- `sendMessage` delivery modes (`steer`, `followUp`, `nextTurn`)
- `registerCommand` vs `registerTool` distinctions
- Plan mode design pattern (subtask-driven loop)
- Common imports and golden rules

If the extension uses config, read
[references/config-modal-howto.md](references/config-modal-howto.md) — ConfigManager
is the only config pattern in this repo; never hand-roll load/save/modal wiring.

If you are writing tool descriptions, read
[references/tool-description-writing.md](references/tool-description-writing.md)
for the per-layer classification and writing workflow.

**Completion criterion:** Feature implemented, tested, committed, pushed.

### Stage 5: Live Test

1. Agent confirms: tests pass, committed, pushed
2. User pulls in runtime clone (or `pi install git:https://...@<branch>`)
3. User `/reload`s or restarts pi
4. Agent tests with a command exercising the change

**Reload semantics:**

- `/reload` — hot-reload: re-evaluates entry point. jiti may retain cached
  sub-imports (`shell.ts`, `find.ts`).
- Full restart — clears all jiti caches. If behavior doesn't change after
  `/reload`, request a full restart.

**Completion criterion:** Change visible in running pi. User confirms.

### Stage 6: Finalization

- Package README reflects reality (commands, config, attribution); new
  packages get a row in the root `README.md` inventory table.
- Config lives in `ConfigManager` from day one — see
  [references/config-modal-howto.md](references/config-modal-howto.md).

**Completion criterion:** Documentation current. Repo map entry exists.

## Code Rules

### No Handrolling

Before implementing any utility, check if pi already exports it.

Full audit procedure (smell catalog, tier classification, step-by-step):
[references/handrolling-audit.md](references/handrolling-audit.md).

Quick checks against pi/pi-base exports:

| Utility area                      | Check against                                                                                                                                                                            |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Path helpers                      | `getAgentDir`, `expandTildePath` (pi-coding-agent)                                                                                                                                       |
| Config loading / saving           | `ConfigManager` (pi-base) — the only config pattern; never hand-roll load/save                                                                                                           |
| LLM helpers                       | `callWithJsonResponse` (pi-base)                                                                                                                                                         |
| Config management                 | `ConfigManager` (pi-base); see [config-modal-howto.md](references/config-modal-howto.md)                                                                                                 |
| Tool description layers           | `promptSnippet`, `description`, `promptGuidelines`, `parameters.*.description` — see [pi-system-prompt-architecture.md](references/pi-system-prompt-architecture.md) for rendering rules |
| Tool description writing workflow | [tool-description-writing.md](references/tool-description-writing.md) — classification, per-layer writing, audit                                                                         |

Three-tier classification:

- **Tier 1** — direct pi replacement exists → drop hand-rolled code
- **Tier 2** — pattern repeated across extensions → extract shared helper, don't inline
- **Tier 3** — genuinely domain-specific → keep, document why

For Tier-2 patterns: flag to user ("appears in N extensions — worth extracting?").
Don't extract without approval.

### Copy Verbatim

When an upstream source exists, copy files with `cp -r`. Every line must trace
to either a copy from upstream or a targeted edit. If writing a file from
scratch without a source, flag it explicitly.

**Bulk regex fixes are forbidden.** Fix each file individually with the edit tool.
The sed spiral causes cascading damage.

## Anti-Patterns

| Anti-pattern                                   | What's happening                     | What to do                                 |
| ---------------------------------------------- | ------------------------------------ | ------------------------------------------ |
| Writing files from memory when upstream exists | Rewriting introduces subtle bugs     | `cp -r` from upstream, edit in place       |
| `web_fetch` on GitHub URLs                     | Returns HTML, not source             | `git clone --depth 1 <url> tmp/`           |
| Bulk regex / sed across many files             | Cascading damage                     | Fix individually with edit tool            |
| Scope creep ("I'll include that next commit")  | Unrelated changes accumulate         | Separate concern → separate commit         |
| Skipping deep diff analysis                    | Jumping to implementation blind      | Stop. Do the diff analysis first.          |
| "Not required" interpreted as "nice to have"   | Building things not asked for        | Delete everything not explicitly requested |
| Deleting tests instead of fixing them          | Fatigue / poor judgment              | Fix, don't delete. Always.                 |
| `/reload` expected to clear all caches         | jiti retains sub-module cache        | Request full restart                       |
| "I restarted pi" but nothing changed           | User did `/reload`, not full restart | Confirm: was it a full process restart?    |

## When Stuck

- **Spiral (3+ attempts on same problem):** Stop. Write `tmp/<date>-postmortem.md`.
  Wait for user. No new fixes, no "one more try."
- **Runtime doesn't match source after fix:** Confirm runtime clone was pulled
  (`git log`), request full restart (not just `/reload`).
- **Tests pass but runtime fails:** Source and runtime are different locations.
  User must pull first.
- **Misunderstood intent:** Stop. Re-state scope in 2 sentences. Rewrite the plan.
- **Unfamiliar API or pattern:** Skim
  [references/cheatsheet.md](references/cheatsheet.md) — it covers events, TUI,
  state persistence, sendMessage, commands vs tools, and debugging tips.

## Done

- [ ] Tests pass (run from monorepo root)
- [ ] Committed and pushed to origin
- [ ] Root README inventory row added (if new or changed extension)
- [ ] User pulled in runtime clone and reloaded/restarted pi
- [ ] Live test confirms the change works

## Chained Skills

- **ingest-external-packages** — when auditing upstream packages, porting a
  package into the monorepo, or lifting/grafting features from external sources.
  Includes the operation taxonomy reference (clone/extract/copy/lift/graft/synthesize/replace).
- **tool-description-writer** — when writing or auditing tool descriptions
  (`promptSnippet`, `description`, `promptGuidelines`, AJV field descriptions).
  Companion reference:
  [references/tool-description-writing.md](references/tool-description-writing.md)
  covers per-layer classification, writing, round-trip audit, and validation.

## Reference Catalog

Each reference captures a specific domain. Read the relevant one before
starting work that touches its area.

| File                                                                                                                         | What it covers                                                                                                                                                                                                                                                                                                                                  | Read when...                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| [references/cheatsheet.md](references/cheatsheet.md)                                                                         | API surface: ExtensionAPI, ExtensionContext, all `pi.on()` events, state persistence via `appendEntry`, `registerCommand` vs `registerTool`, TUI interaction (notifications, dialogs, custom components, `ctx.hasUI` guards), three `sendMessage` delivery modes, plan mode design pattern, debugging tips, common imports, golden rules        | You need a quick API lookup: how do I send a message? What events exist? How do I persist state? How do TUI dialogs work?                    |
| [references/session-lifecycle.md](references/session-lifecycle.md)                                                           | Complete mermaid sequence diagram showing all events from startup through multi-turn conversation with compaction. Event category reference: session lifecycle, agent lifecycle, turn lifecycle, message lifecycle, tool execution, provider streaming, extension hook events                                                                   | You need to understand event ordering to choose the right `pi.on()` hook, or you're debugging a handler that fires at the wrong time         |
| [references/pi-system-prompt-architecture.md](references/pi-system-prompt-architecture.md)                                   | Four-layer tool description architecture: how `promptSnippet`, `description`, `promptGuidelines`, and parameter descriptions each render in the system prompt vs the LLM API tool block. Prompt rebuild mechanics, guidelines deduplication, tool registry merging, built-in replacement                                                        | You're writing tool descriptions and need to know which layer the model sees where, or debugging why a guideline appears twice or not at all |
| [references/tool-description-writing.md](references/tool-description-writing.md)                                             | Structured workflow for writing tool descriptions: sentence classification (routing/safety/behavior/schema/implementation), per-layer writing with length and content constraints, round-trip audit, anti-patterns (snippet == description, guidelines as schema docs, implementation leak, naked tool names), validation script, done criteria | You're writing or rewriting tool descriptions, especially for multi-parameter tools where layer confusion is easy                            |
| [references/handrolling-audit.md](references/handrolling-audit.md)                                                           | Systematic audit procedure for identifying code that reimplements pi/pi-base exports. Smell catalog (7 patterns mapped to tiers), three-tier classification (T1: drop it, T2: flag for extraction, T3: document why), edge cases for version mismatches and functional supersets                                                                | You're auditing an extension for redundant code, or you're about to implement a utility and want to check if pi already has it               |
| [references/config-modal-howto.md](references/config-modal-howto.md)                                                         | ConfigManager + settings modal toolkit: schema/defaults/fields declaration, layered scopes (global/project/session), env layer, pending-session flush, diff-based saves, selector and display-all flow, opt-outs                                                                                                                                | You're writing or changing any config surface — ConfigManager is the only config pattern in this repo                                        |
| [../ingest-external-packages/references/operation-taxonomy.md](../ingest-external-packages/references/operation-taxonomy.md) | Definitions and when-to-use guidance for each operation type: clone, extract, copy, lift, graft, synthesize, replace                                                                                                                                                                                                                            | You need to decide which upstream integration strategy to use                                                                                |
