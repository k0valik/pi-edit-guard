# ConfigManager How-To Guide

## What ConfigManager replaces

Before ConfigManager, every extension hand-rolled its own config loading, validation,
saving, modal wiring, and scope management. The patterns varied:

- Some used `openSettingsModal` directly with inline `Field[]`.
- Some read/wrote JSON with raw `readFileSync`/`writeFileSync`.
- Some layered defaults + global + project manually with duplicated `validateConfig` functions.
- Some forgot to wire scope tabs, diff-based save, or reset/delete actions.

ConfigManager consolidates all of that into a single declarative instance. You define
the schema, defaults, fields, and optional validation once. It handles:

- Layered loading (defaults → global → project → env → session)
- Diff-based save (preserves unknown keys, never overwrites untouched fields)
- Pre-selector → edit mode | Display All modal wiring
- Reset scope and delete scope actions
- Malformed-JSON warnings
- Per-field validation warnings in the modal UI
- Env-var overrides via a declarative map

Everything else — the config type, the constants, the command handlers, the
`session_start` reload — is still your responsibility. ConfigManager is the config
engine, not the extension skeleton.

---

## The :config command flow

The modern `:config` command flow is:

1. **Pre-selector** — the user picks a scope (Global, Project Local, Session) or
   "Display all settings."
2. **Edit mode** — scope-locked buffered modal. Tab cycles actions only. Actions:
   Save, Discard, Reset, Delete (session: no Delete). Confirms are yes/no.
3. **Display All** — read-only multi-tab view (Global, Project Local, Env, Session,
   Defaults). Effective-value annotations via `valueNote`. Actions: Cancel, Edit.

Opted-out scopes and uninitialized session render **dim + unselectable** in the
pre-selector. "Display all settings" is always available.

The old modal-level 5-way save submenu ("Save to Global / Save to Project Local /
Discard / Cancel") is gone. Scope is chosen before edit mode opens; the confirm
dialog is a real yes/no ("Really save to Project Local?").

---

## Minimal file layout

Every extension that uses ConfigManager follows this shape:

```
<pkg>/
├── src/
│   ├── config.ts          # ConfigManager instance — THE canonical config surface
│   ├── commands.ts        # Slash command handlers (optional but standard)
│   ├── index.ts           # Extension entry point — wires session_start, commands
│   └── ...
└── package.json
```

`config.ts` is the single source of truth for config shape, defaults, fields, and
validation. Nothing else in the package should duplicate those definitions.

If the config type is reused by tests or other modules, put it in `src/types.ts` and
re-export from `config.ts`. If it is only used inside `config.ts`, define it inline.

---

## Step 1: Define the config shape

```ts
// src/config.ts
import { ConfigManager } from "@k0valik/pi-base";
import type { Field } from "@k0valik/pi-base/settings";

export interface PkgConfig {
  enabled: boolean;
  timeoutMs: number;
  mode: "auto" | "strict" | "off";
  tags: string[];
}

export const DEFAULTS: PkgConfig = {
  enabled: true,
  timeoutMs: 2000,
  mode: "auto",
  tags: [],
};
```

Rules:

- One `DEFAULTS` object, exported. Every key that can appear on disk must have a
  default here. Missing keys in the file fall back to this object on load.
- The interface covers the full persisted shape. Do not use `Partial<T>` in the
  public config type — the config file may have missing keys, but the type represents
  the fully-resolved shape after defaults are applied.

---

## Step 2: Write the `validate` function

```ts
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function validateConfig(raw: Record<string, unknown>): PkgConfig {
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULTS.enabled,
    timeoutMs:
      typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs)
        ? clamp(raw.timeoutMs, 100, 60000)
        : DEFAULTS.timeoutMs,
    mode:
      typeof raw.mode === "string" && ["auto", "strict", "off"].includes(raw.mode)
        ? raw.mode
        : DEFAULTS.mode,
    tags: Array.isArray(raw.tags)
      ? raw.tags.filter((t): t is string => typeof t === "string")
      : typeof raw.tags === "string"
        ? raw.tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : DEFAULTS.tags,
  };
}
```

Rules:

- Accepts `Record<string, unknown>` — this is what the modal passes to `validate`
  after the user confirms. It is also what ConfigManager calls after loading from
  disk. The raw record may have flat keys (from the modal) or nested keys (from a
  hand-edited file). Your validator must handle both.
- Always falls back to `DEFAULTS` on type mismatch. Never throw.
- Clamp numeric ranges inline. No magic numbers outside this function.
- Return the fully typed `PkgConfig`. Never return `Partial<T>`.

### Handling dot-notation keys in `validate`

When your fields use dot-notation keys (e.g. `"channels.terminal"`), the modal's
`onSave` passes flat keys in the `values` record. But a hand-edited config file may
have nested objects. Your validator must read from both shapes:

```ts
const get = <T>(flatKey: string, nestedPath: string): T | undefined => {
  const flat = raw[flatKey] as T | undefined;
  if (flat !== undefined) return flat;
  let o: unknown = raw;
  for (const part of nestedPath.split(".")) {
    if (!o || typeof o !== "object") return undefined;
    o = (o as Record<string, unknown>)[part];
  }
  return o as T | undefined;
};

// usage:
const terminalBackend = get<string>("terminal.backend", "terminal.backend");
```

See `pi-notify/src/config.ts` for a production example of this pattern.

### Sanitizing strings that touch the filesystem or shell

If your config controls a path or shell command, sanitize it in `validate`:

```ts
function sanitizePath(val: unknown, fallback: string): string {
  if (typeof val !== "string") return fallback;
  if (val.includes("..") || val.includes("/") || val.includes("\\")) return fallback;
  return val.replace(/[^a-zA-Z0-9_.-]/g, "").trim() || fallback;
}
```

See `pi-notify/src/config.ts` (`sanitizeSoundIdentifier`) and the `pi-bang-autocomplete`
`runtimeStorePath` restriction.

---

## Step 3: Create the ConfigManager instance

```ts
// src/config.ts
export const config = new ConfigManager<PkgConfig>({
  id: "<pkg>", // machine ID, lower-case, no spaces
  label: "@k0valik/<pkg>", // human label shown in the modal frame
  filename: "<pkg>-config.json",
  defaults: DEFAULTS,
  fields: (cfg) => [/* ... */] as Field[],
  validate: validateConfig,
  env: {
    timeoutMs: "PI_PKG_TIMEOUT_MS",
    enabled: "PI_PKG_ENABLED",
  },
});
```

Rules:

- `id` is the machine identifier used in internal paths. Lowercase, no spaces,
  no punctuation beyond hyphens.
- `label` is what renders in the modal frame title. Use the npm package name.
- `filename` is the config file name. Derived from `id` if omitted.
- `defaults` must be the same object as the exported `DEFAULTS`.
- `fields` receives the fully-resolved config and returns `Field[]`. Build the
  array fresh each call — do not cache it.
- `validate` is called after loading from disk and after the user confirms the
  modal. It must be idempotent: calling it on already-validated data must return
  the same shape.
- `env` is optional. It maps config keys to env-var names. Boolean keys use
  `readBooleanEnv` semantics; numeric keys use `readPositiveIntEnv` semantics.
  ConfigManager applies these after `validate`, so env overrides always win.

### Default-true scopes + opt-out

Scopes default to all three enabled (global, project, session). Extensions opt out
via the `scopes` option:

```ts
new ConfigManager<PkgConfig>({
  id: "<pkg>",
  // ...
  scopes: { project: false }, // disable project-local tab
});
```

| Scope     | Default | Opt-out                                            |
| --------- | ------- | -------------------------------------------------- |
| `global`  | `true`  | `scopes: { global: false }`                        |
| `project` | `true`  | `scopes: { project: false }`                       |
| `session` | `true`  | `scopes: { session: false }` or no `sessionConfig` |

Session scope is further controlled by `sessionConfig` — set to `false` to disable
session config entirely.

---

## Step 4: Define the fields

The `fields` function receives the current config and returns `Field[]`:

```ts
fields: (cfg) => [
  {
    key: "enabled",
    type: "boolean",
    label: "Enabled",
    description: "Enable/disable the extension.",
    value: cfg.enabled,
    valueDescriptions: {
      on: "Extension is active",
      off: "Extension is suspended",
    },
  },
  {
    key: "timeoutMs",
    type: "number",
    label: "Timeout (ms)",
    description: "Max time to wait before falling back.",
    value: cfg.timeoutMs,
    min: 100,
    max: 60000,
    step: 100,
    integer: true,
  },
  {
    key: "mode",
    type: "enum",
    label: "Mode",
    description: "Processing mode.",
    value: cfg.mode,
    options: ["auto", "strict", "off"],
    optionLabels: {
      auto: "auto (default) — pick best",
      strict: "strict — highest accuracy",
      off: "off — disabled",
    },
  },
  {
    key: "tags",
    type: "string",
    label: "Custom Tags",
    description: "Comma-separated tags (e.g. 'feat, fix, docs').",
    value: cfg.tags.join(", "),
  },
] as Field[],
```

### Field key conventions

| Convention   | Example                                  | When to use                                                           |
| ------------ | ---------------------------------------- | --------------------------------------------------------------------- |
| Flat         | `"enabled"`, `"backend"`                 | Default. Works with and without scopes.                               |
| Dot-notation | `"channels.terminal"`, `"sound.backend"` | Only when you want nested config values in the loaded config objects. |

**Do not use underscore-separated keys** (`"components_spinner"`). This requires manual flattening/reconstruction in `validate` and `onSave`.

### `visibleWhen`

Hide a field based on sibling values:

```ts
{
  key: "entropyThreshold",
  type: "number",
  label: "Entropy Threshold",
  value: 5.5,
  visibleWhen: (ctx) => ctx.get("enableEntropy") === true,
}
```

The `ctx` provides:

- `get(key)` — the resolved (merged) value of a sibling field
- `getScoped(key, scope?)` — the value from a specific scope
- `scope` — the current scope (`"global"`, `"project"`, `"session"`, `"env"`, or `"defaults"`)

### `requiresReload`

Set `requiresReload: true` on fields that need `/reload` to take effect:

```ts
{
  key: "enableAgentTool",
  type: "boolean",
  label: "Enable Agent Tool",
  description: "Register agent tools (requires /reload).",
  value: cfg.enableAgentTool,
  requiresReload: true,
}
```

The modal shows a reload hint in the confirm prompt when any dirty field has this flag.

### `default`

Set `default` on a field to enable per-field reset (`Alt+R`):

```ts
{
  key: "timeoutMs",
  type: "number",
  label: "Timeout (ms)",
  value: cfg.timeoutMs,
  default: DEFAULTS.timeoutMs,
}
```

If you omit `default`, ConfigManager auto-populates it from `DEFAULTS` when opening
the modal. You can still set it explicitly if the field default differs from the
config-level default.

### `depth`

Use `depth` for visual grouping:

```ts
{ key: "channels", type: "string", label: "Channels", value: "", depth: 0 },
{ key: "channels.terminal", type: "boolean", label: "Terminal", value: true, depth: 1 },
{ key: "channels.desktop",  type: "boolean", label: "Desktop",  value: true, depth: 1 },
```

### `valueDescriptions`

Per-value help text for boolean, enum, and number fields:

```ts
{
  key: "mode",
  type: "enum",
  value: cfg.mode,
  valueDescriptions: {
    auto: "auto (default) — pick best",
    strict: "strict — highest accuracy",
    off: "off (disabled)",
  },
}
```

---

## Step 5: Wire the config command

Every extension with a config modal registers a `:config` command:

```ts
// src/commands.ts
import { config, DEFAULTS } from "./config.ts";

export async function handleConfigCommand(
  _args: string,
  ctx: ExtensionContext,
  cwd: string,
): Promise<void> {
  await config.openSettings(ctx, cwd, (updated) => {
    // Update in-memory state directly.
    // Do NOT call config.load() here — it re-reads from disk and
    // silently re-applies env overrides, reverting the user's choices.
    state.config = updated;
    applyUpdatedConfig(updated);
  });
}
```

```ts
// src/index.ts
import { handleConfigCommand } from "./commands.ts";

pi.registerCommand("<pkg>:config", {
  description: "Show config options for <pkg>",
  handler: async (_args, ctx) => {
    await handleConfigCommand(_args, ctx, ctx.cwd);
  },
});
```

Rules:

- The `:config` command opens the modal with full scope selection (pre-selector).
- The `onSave` callback receives the validated config. Update in-memory state
  directly. Do not reload from disk.
- If your extension has a toggle command (e.g. `<pkg> on|off`), it should write
  to global scope. This is the expected behavior — toggles affect the user's
  global preference.

### Toggle commands

```ts
pi.registerCommand("<pkg>", {
  description: "Enable/disable <pkg>",
  handler: async (args, ctx) => {
    const sub = args.trim().toLowerCase();
    const current = config.load(ctx.cwd);
    if (sub === "on") {
      config.save({ ...current, enabled: true }, "global", ctx.cwd);
      ctx.ui.notify("<pkg>: enabled", "info");
    } else if (sub === "off") {
      config.save({ ...current, enabled: false }, "global", ctx.cwd);
      ctx.ui.notify("<pkg>: disabled", "info");
    } else {
      ctx.ui.notify(`<pkg>: enabled=${current.enabled} ...`, "info");
    }
  },
});
```

### Commands that need a reload

If your extension registers tools or modifies behavior that is read at factory time,
tell the user to `/reload`:

```ts
if (subcommand === "auto") {
  const current = config.load();
  config.save({ ...current, overwriteBuiltinEdit: !current.overwriteBuiltinEdit }, "global");
  ctx.ui.notify("Auto-retry toggled — /reload required", "info");
}
```

Mark those fields with `requiresReload: true` in the field definition so the modal
surfaces the hint automatically.

---

## Step 6: Load config at session_start

Load config fresh on every `session_start` so the extension picks up external
changes (hand-edited config files, changes from another session, etc.):

```ts
pi.on("session_start", async (_event, ctx) => {
  state.config = config.load(ctx.cwd);
  // Re-apply any runtime side-effects that depend on config:
  applyTitle(pi, ctx, state);
});
```

Rules:

- Always pass `ctx.cwd` so project-local overrides are respected.
- Update in-memory state directly. Do not re-create the ConfigManager instance.
- If the extension has runtime side-effects (title re-application, spinner restart,
  tool re-registration), trigger them here.

### Factory-time config (global-only)

Some extensions need a config value at factory time — before any session has started.
This is typical for tool registration decisions that must be stable for the lifetime
of the factory:

```ts
// At module top level or in the extension factory:
const agentToolEnabled = config.load().enableAgentTool;

export default function (pi: ExtensionAPI) {
  if (agentToolEnabled) {
    pi.registerTool({ name: "my_tool", ... });
  }
}
```

When doing this, document that the value requires `/reload` after changing. The
`config.load()` call without `cwd` reads only global scope, which is correct for
factory-time decisions.

---

## Step 7: Live config updates with `onChange`

ConfigManager's `openSettings` accepts an optional `onChange` callback for
per-field live updates:

```ts
await config.openSettings(
  ctx,
  ctx.cwd,
  (updated) => {
    state.config = updated;
  },
  undefined,
  (key, value) => {
    if (key === "muted") {
      persistMute(value as boolean);
      return;
    }
    // Live-preview other fields here.
  },
);
```

Rules:

- `onChange` is only called in buffered mode (the default for config). Each
  keystroke or toggle fires it before the user confirms.
- Use it for side-effects that should happen immediately (mute toggling, spinner
  start/stop, status bar updates).
- Do not call `config.save()` inside `onChange` — that defeats the purpose of
  buffered mode. Save happens automatically on confirm.
- Do not call `config.load()` inside `onChange`. You already have the new value
  in the callback arguments.

See `pi-voice/src/index.ts` for a production example of `onChange` handling mute
toggles and voice changes live.

---

## Step 8: Augmenting load for security restrictions

Some configs need runtime restrictions that cannot be expressed in the schema alone.
The canonical pattern is to augment `config.load` after construction:

```ts
// src/config.ts
const _origLoad = config.load.bind(config);
config.load = (cwd?: string, configDir?: string): BangAutocompleteConfigResolved => {
  const cfg = _origLoad(cwd, configDir);
  // Enforce: runtimeStorePath can only come from global scope.
  if (cwd && process.env.VITEST !== "true") {
    const globalRaw = readConfig<Partial<BangAutocompleteConfigResolved>>(
      "bang-autocomplete-config.json",
      configDir ?? getExtensionsDir(),
    );
    cfg.runtimeStorePath = globalRaw?.runtimeStorePath ?? DEFAULTS.runtimeStorePath;
  }
  return cfg;
};
```

Rules:

- Call the original `config.load` first, then patch the result.
- Keep the original bound method so you do not lose the layered loading and env
  override logic.
- Only apply the restriction in production (guard with `VITEST !== "true"` or
  similar) unless the test explicitly exercises the restriction.
- The restriction logic belongs in `config.ts`, not in `index.ts`. Other modules
  that import `config` should get the restricted version automatically.

See `pi-bang-autocomplete/src/config.ts` for a full production example.

---

## Step 9: State that lives outside the config file

Some persistence needs are not config — they are runtime state. The canonical
pattern is to keep them in a separate file with a `-state` suffix:

```ts
// src/config/loader.ts or src/state.ts

const STATE_FILENAME = "<pkg>-state.json";

export function readPersistedEnabled(): boolean | null {
  const parsed = readConfig<{ enabled: unknown }>(STATE_FILENAME);
  return typeof parsed?.enabled === "boolean" ? parsed.enabled : null;
}

export function writePersistedEnabled(enabled: boolean): boolean {
  return writeConfig(STATE_FILENAME, { enabled });
}

export function clearPersistedEnabled(): void {
  deleteConfig(STATE_FILENAME);
}
```

Rules:

- State files go in the same directory as config files (extensions dir or `.pi/`).
- State is manipulated by slash commands (e.g. `/rtk-rewrite on|off`), not by the
  modal. The modal shows state as read-only status rows.
- Merge state into the loaded config in a `loadConfig` wrapper:

```ts
export function loadConfig(cwd?: string): RtkConfig {
  const loaded = config.load(cwd);
  const persistedAnsi = readAnsiStripping();
  return {
    ...loaded,
    techniques: {
      ...loaded.techniques,
      ansiStripping: persistedAnsi ?? loaded.techniques.ansiStripping,
    },
  };
}
```

This wrapper belongs in a `loader.ts` or `state.ts` file, not in `config.ts`.
ConfigManager does not know about state files.

See `pi-rtk/src/config/loader.ts` for the full pattern.

---

## Step 10: The `save` contract

ConfigManager's `save()` returns `{ path, created, changed }`:

```ts
const result = config.save(updated, "global", ctx.cwd);
// result.path  — absolute path of the written file
// result.created — true on first write, false on update
// result.changed — true if any field was written, false if no diff
```

Rules:

- Pass the full config object, not just the changed field. ConfigManager computes
  the diff internally.
- Pass the correct scope. Toggle commands should almost always write to `"global"`.
- On first project-local save, `created` is `true` and the flow fires a notify.
  Subsequent saves are silent.
- If the extension has a state file, update it separately in the same handler.

---

## Step 11: Layer APIs

ConfigManager exposes layer-level inspection for the Display All view and
advanced debugging:

```ts
// Merged values up to and including a given scope.
const globalValues = config.layerValues("global", cwd);
const projectValues = config.layerValues("project", cwd);
const envValues = config.layerValues("env", cwd);
const sessionValues = config.layerValues("session", cwd);

// Per-layer contributions + per-key winning scope.
const inspection = config.inspect(cwd);
// inspection.layers — { defaults, global, project, env, session }
// inspection.winners — { key: "global" | "project" | "env" | "session" | "defaults" }

// Provenance sources for the enabled scopes.
const sources = config.scopeSources(cwd);
// [{ scope: "global", label: "Global", path: "...", exists: true, note: "..." }, ...]
```

Resolution chain: **defaults → global → project → env → session** (highest priority).

`layerValues("env")` applies env overrides on top of project-layer values.
`layerValues("session")` applies session overrides on top of env-layer values.

`getScopes()` returns the resolved scope availability (with defaults applied).
`hasSession()` returns true after `initSession` has run and session is not opted out.

---

## Step 12: Env overrides

Env overrides are applied after loading and after `validate`. They always win over
file config:

```ts
export const config = new ConfigManager<PkgConfig>({
  // ...
  env: {
    timeoutMs: "PI_PKG_TIMEOUT_MS",
    enabled: "PI_PKG_ENABLED",
  },
});
```

Rules:

- Boolean env vars: `"1"`, `"true"`, `"yes"`, `"on"` → `true`; `"0"`, `"false"`,
  `"no"`, `"off"` → `false`.
- Numeric env vars: parsed with `Number.parseInt`, clamped to positive integers.
- Env overrides are not editable in the modal. They are a deployment-time escape
  hatch. They are visible in Display All's Env tab.
- Document env vars in the extension README, not in the modal.

---

## Step 13: Session config

Session-scoped config is persisted to the session JSONL via `appendEntry` and
recovered on `session_start`. It is the highest-priority override layer, isolated
per leaf with parent-chain inheritance.

```ts
// In index.ts:
config.initSession(sessionId, leafId, sessionManager.getEntries(), pi.appendEntry);
```

`initSession()` is now **optional**. ConfigManager lazily detects an existing
session when `openSettings()` is called: if the session JSONL file exists on disk
and `getLeafId()` is non-null, it initializes automatically. Explicit calls still
work and take precedence (re-init with different args re-anchors — this is how
session_start consumers survive in-process switches).

Brand-new sessions have no JSONL file yet (first write is deferred until the first
assistant message), so the session scope is **PENDING/AVAILABLE** (in-memory until
the session file exists, then auto-persist).

Rules:

- `initSession()` is only needed if you want session config **before** the modal
  opens (e.g. programmatic `load()`/`save()` at factory time). Otherwise omit it.
- Session config is opt-out: set `sessionConfig: false` or `scopes: { session: false }`
  to disable.
- The session tab in Display All shows in-memory per-leaf overrides.
- Session save appends to the session JSONL for crash recovery. If `appendEntry`
  is unavailable during lazy detection, save still works for the in-memory store
  but does not append to the JSONL.

---

## Step 14: Diff-based save

ConfigManager.save() writes only fields whose value differs from `DEFAULTS`.

- **First save** (no file exists): writes ALL fields — the file is fully populated.
- **Subsequent saves**: only the fields that actually changed in this session are
  written. Everything else stays untouched.
- **Unknown keys** (hand-edited extras) are automatically preserved by the
  read-patch-write cycle.
- **No automatic removal**: only explicit reset/delete removes keys from the file.

This means you should never hand-edit a config file to add future keys and expect
them to be deleted by the modal. They will persist across resets.

---

## Step 15: Loading without a modal

Not every config load goes through the modal. Extensions read config at runtime:

```ts
// In event handlers, tool execution, etc.
const cfg = config.load(ctx.cwd);
```

Rules:

- Always pass `ctx.cwd` so project-local overrides are respected.
- `config.load()` returns the fully resolved config (defaults → global → project →
  env). It does not include session overrides — merge those with `layerValues("session")`
  if needed.
- `config.load()` does not include state-file overrides — merge those in your own
  `loadConfig` wrapper if needed.
- Cache the result for the duration of the handler, but re-read on `session_start`
  to pick up external changes.

---

## Step 16: Saving without the modal

Some extensions need to save config programmatically (toggle commands, reset commands):

```ts
const current = config.load(ctx.cwd);
config.save({ ...current, enabled: newValue }, "global", ctx.cwd);
```

Rules:

- Pass the full config object, not just the changed field. ConfigManager computes
  the diff internally.
- Pass the correct scope. Toggle commands should almost always write to `"global"`.
- If the extension has a state file, update it separately in the same handler.

---

## Migrating from openSettingsModal

If you are migrating an extension that currently calls `openSettingsModal` directly:

1. Move `CONFIG_FILENAME`, `DEFAULTS`, `validateConfig`, and `loadConfig` into
   `src/config.ts` under a ConfigManager instance.
2. Replace the `openSettingsModal` call with `config.openSettings(ctx, cwd, onSave)`.
3. Move any `saveConfigScoped` logic into the `onSave` callback or rely on
   ConfigManager's built-in diff save.
4. Keep backward-compat re-exports for `DEFAULTS`, `validateConfig`, and
   `saveConfigScoped` if other modules in the package import them.
5. If the extension has a state file (persisted on/off, runtime overrides), keep
   the state helpers in a separate `loader.ts` or `state.ts` and merge them in a
   `loadConfig` wrapper.
6. Update test mocks to include `ConfigManager` with the new layer APIs.
7. Run the full test suite. The most common migration failures are:
   - Forgetting to merge persisted state overrides into `loadConfig`.
   - Forgetting to handle dot-notation keys in `validate`.
   - Tests that mock `loadConfig` but not `ConfigManager`.

> **Deprecated:** `openSettingsModal` is deprecated for config flows. The modal/frame
> toolkit remains available for non-config overlays (pickers, selectors, action menus,
> pi-files-touched pattern). Config flows must use `ConfigManager`.

---

## Survey: how 8 packages wire ConfigManager

### pi-bash-timeout — minimal

- Single `number` field, no env overrides, no state.
- `config.openSettings(ctx, ctx.cwd, () => {})` — empty callback because the
  extension re-reads config on every bash call via `config.load(ctx.cwd)`.
- No `session_start` reload needed because the config is read fresh each time.

### pi-notify — nested dot-notation

- 16 fields across nested objects (`channels.terminal`, `sound.backend`, etc.).
- Uses dot-notation keys. The modal resolves nested values natively.
- `validate` handles both flat (modal) and nested (file) shapes with a `get` helper.
- `session_start` reloads config: `state.config = config.load(ctx.cwd)`.
- Has a `notify:config` command and a bare `notify` command with subcommands.

### pi-session-name — large flat schema with custom validation

- 17 fields, mix of booleans, numbers, strings, enums, model fields.
- `validate` handles string-to-array coercion (comma-separated tags), model object
  parsing, and range clamping.
- Fields include `requiresReload: true` for agent-tool registration.
- `session_start` reloads config and re-applies runtime state.

### pi-redact-secrets — env overrides + error handling

- 10 fields, 6 env overrides (boolean, numeric, string-enum).
- `validate` handles optional properties, path-list sanitization, and mode parsing.
- `session_start` loads config inside a try/catch with a fallback to `EMPTY_CONFIG`
  and a warning notification.
- Config command updates `state.config` and `state.mode` in the onSave callback.

### pi-bang-autocomplete — security restriction on load

- 10 numeric fields with env-overridden clamps.
- Augments `config.load` to enforce `runtimeStorePath` as global-only.
- Guards the augmentation with `VITEST !== "true"` so tests can exercise the
  unrestricted path.
- Exports `DEFAULTS` from `types.ts` and re-exports from `config.ts`.

### pi-cache — factory-time config + requiresReload

- Loads `config.load()` without `cwd` at factory time for tool registration.
- Uses `requiresReload: true` on `enableAgentTool` because tool registration
  happens once at factory time.
- Extension reads `config.load(ctx.cwd)` per-tool-call for runtime decisions.

### pi-voice — onChange for live updates

- Uses `config.openSettings(ctx, ctx.cwd, onSave, undefined, onChange)`.
- `onChange` handles `muted` and `voice` keys immediately: persists, aborts jobs,
  updates status bar.
- `onSave` persists the full config and updates the in-memory `config` variable.
- `session_start` reloads config and refreshes auth.

### pi-robust-edit — programmatic save from slash command

- Minimal 2-field config.
- `/robust-edit auto` subcommand calls `config.save({ ...current, overwriteBuiltinEdit: newValue }, "global")` directly.
- `/robust-edit:config` opens the modal.
- Factory-time `config.load().enableAgentTool` gates tool registration.
- Both fields use `requiresReload: true` because tool registration is factory-time.

### pi-window-title — state update in onSave

- `openWindowTitleSettings` passes `(updated) => { state.config = updated; ... }`
  as the onSave callback.
- `session_start` reloads config: `state.config = config.load(ctx.cwd)`.
- Slash command handlers re-read config before each action:
  `const cfg = config.load(ctx.cwd); state.config = cfg;`

### pi-rtk — state file + augmented load

- `DEFAULTS` and `validateConfig` live in `src/config.ts` under ConfigManager.
- State helpers (persisted on/off, ANSI override) live in `src/config/loader.ts`.
- `loadConfig(cwd)` delegates to `config.load(cwd)` and merges the persisted ANSI
  override from the state file.
- `openRtkSettings` delegates to `config.openSettings(ctx, cwd, onSave)`.
- Backward-compat re-exports (`DEFAULTS`, `validateConfig`, `saveConfigScoped`)
  keep internal callers and tests working.

---

## Testing ConfigManager-based configs

### Unit testing `validateConfig`

Test the validator directly — it is a pure function:

```ts
import { validateConfig, DEFAULTS } from "../src/config.ts";

it("falls back to defaults on type mismatch", () => {
  expect(validateConfig({ timeoutMs: "not a number" }).timeoutMs).toBe(DEFAULTS.timeoutMs);
});

it("clamps numeric ranges", () => {
  expect(validateConfig({ timeoutMs: -5 }).timeoutMs).toBe(100);
  expect(validateConfig({ timeoutMs: 999999 }).timeoutMs).toBe(60000);
});
```

### Unit testing the ConfigManager instance

Mock `@k0valik/pi-base` and provide a `ConfigManager` stub with the full
layer-API surface:

```ts
vi.mock("@k0valik/pi-base", () => {
  const mock = {
    loadConfig: (filename: string, defaults: any, opts?: any) => {
      /* ... */
    },
    readConfig: () => null,
    writeConfig: () => true,
    deleteConfig: () => {},
    getExtensionsDir: () => "/home/user/.pi/agent/extensions",
    readBooleanEnv: (_name, fallback) => fallback,
    readPositiveIntEnv: (_name, fallback) => fallback,
  } as any;

  mock.ConfigManager = class {
    constructor(private opts: any) {}
    getScopes() {
      return { global: true, project: true, session: true };
    }
    hasSession() {
      return false;
    }
    layerValues(scope: string, cwd?: string, configDir?: string) {
      const loaded = mock.loadConfig(this.opts.filename, this.opts.defaults, {
        cwd,
        configDir,
        merge: "deep",
      });
      const result = { ...this.opts.defaults, ...loaded };
      const envMap = this.opts.env as Record<string, string> | undefined;
      if (envMap && scope !== "global") {
        for (const [key, envVar] of Object.entries(envMap)) {
          const val = result[key as keyof typeof result];
          if (typeof val === "boolean")
            result[key as keyof typeof result] = mock.readBooleanEnv(envVar, val);
          else if (typeof val === "number")
            result[key as keyof typeof result] = mock.readPositiveIntEnv(envVar, val);
        }
      }
      return result;
    }
    inspect() {
      return { layers: {}, winners: {} };
    }
    scopeSources() {
      return [];
    }
    load(cwd?: string) {
      return this.layerValues("session", cwd);
    }
    save() {
      return { path: "", created: false, changed: false };
    }
    openSettings() {}
    resetScope() {}
    deleteScope() {}
    initSession() {}
  } as any;

  return mock;
});
```

Rules:

- The mock `ConfigManager` must include `getScopes`, `hasSession`, `layerValues`,
  `inspect`, `scopeSources`, `save` (returning `{ path, created, changed }`),
  `load`, `openSettings`, `resetScope`, `deleteScope`, and `initSession`.
- The mock `layerValues()` must merge defaults + file config + env overrides
  so tests that assert specific loaded values pass.
- The mock `openSettings()` can be a `vi.fn()` if you only test config loading.
- If tests assert `config.save()` was called, make it a `vi.fn()` and assert on it.

### Integration testing the modal

If you want to test the modal UI end-to-end, use `pi-base`'s own modal tests as
a reference (`packages/pi-base/src/settings/config-flow.test.ts`). Most extensions
do not need this — unit tests on `validateConfig` plus a smoke test on
`config.openSettings()` are sufficient.

---

## Anti-patterns

| Anti-pattern                              | What happens                                                                            | Fix                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Calling `config.load()` in `onSave`       | Re-reads from disk, re-applies env overrides, reverts user's choices                    | Update state directly from the `updated` argument                       |
| Using `openSettingsModal` for config      | No pre-selector, no diff-based save, no scope actions, no malformed-JSON warnings       | Use `config.openSettings()`                                             |
| Underscore-separated field keys           | Manual flatten/reconstruction in `validate` and `onSave`, keys don't match config shape | Use flat keys or dot-notation                                           |
| Patch-based save (read → merge → write)   | Wasted I/O, stale data risk, circular dependencies                                      | Use `config.save()` which computes the diff internally                  |
| Double-load pattern (global then project) | Redundant I/O, inconsistent with the rest of the codebase                               | Single `config.load(cwd)` call handles all layers                       |
| Reloading from disk after save            | Silently re-applies env overrides, reverts user choices                                 | Update state directly                                                   |
| Caching `fields` result                   | Stale field definitions when config changes                                             | Build `Field[]` fresh on each `fields()` call                           |
| Storing transient data in config          | Accidental serialization of in-flight jobs, handles, etc.                               | Keep runtime state in a separate `state` object, not in the config type |

---

## Checklist

Before considering a config module complete:

- [ ] `DEFAULTS` covers every key the config file may contain.
- [ ] `validateConfig` handles both flat (modal) and nested (file) shapes.
- [ ] `validateConfig` never throws — falls back to `DEFAULTS` on any mismatch.
- [ ] All numeric fields are clamped in `validateConfig`, not in event handlers.
- [ ] String fields that control paths or shell commands are sanitized in `validateConfig`.
- [ ] `fields` uses flat keys or dot-notation — no underscore-separated keys.
- [ ] Every non-self-explanatory field has a `description` (user-facing, one sentence).
- [ ] Every `enum` field has `optionLabels` with behavioral summaries and default markers.
- [ ] Fields that need `/reload` have `requiresReload: true`.
- [ ] `env` map covers every config key that should support env overrides.
- [ ] `session_start` reloads config and re-applies runtime side-effects.
- [ ] `initSession()` is **optional** — ConfigManager auto-detects existing sessions on `openSettings()`. Call it explicitly only if you need session config before the modal opens.
- [ ] The `:config` command calls `config.openSettings(ctx, cwd, onSave)`.
- [ ] `onSave` updates in-memory state directly — does not call `config.load()`.
- [ ] Toggle commands write to `"global"` scope.
- [ ] State that lives outside the config file is in a separate `state` file with
      a `loadConfig` wrapper that merges it in.
- [ ] Security restrictions are implemented by augmenting `config.load`, not by
      scattering checks across event handlers.
- [ ] Tests mock `ConfigManager` with `getScopes`, `hasSession`, `layerValues`,
      `inspect`, `scopeSources`, `load`, `save`, `openSettings`, `resetScope`,
      `deleteScope`, `initSession` — and the mock `layerValues` merges defaults + file + env.
- [ ] No `openSettingsModal` calls remain in the package (except for non-config UI).
