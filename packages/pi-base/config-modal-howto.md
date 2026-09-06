# Modal Config & UI Surface — How-To Guide

## Philosophy

One modal system, one field renderer, one set of frame utilities — used by every
package for config, pickers, selectors, and any navigable list. The extension owns
loading, validation, and persistence. The modal owns the UI. Never mix concerns.

**Rule:** if a package handrolls a list, picker, or selector, it's using the wrong
primitive. This doc is the single source of truth for what's available.

---

## Vocabulary

| Term                  | Meaning                                                                           |
| --------------------- | --------------------------------------------------------------------------------- |
| **config file**       | Named JSON file on disk: `<pkg>-config.json`                                      |
| **global scope**      | `~/.pi/agent/extensions/<pkg>-config.json`                                        |
| **project scope**     | `<cwd>/.pi/<pkg>-config.json`                                                     |
| **defaults**          | In-code fallback object; every missing key resolves to this                       |
| **field key**         | String identifier on a `Field`; maps 1:1 to a config property / list row label    |
| **scope tab**         | Global / Project Local selector rendered when `configFilename` is set             |
| **buffered mode**     | Edits held in memory; persisted only on explicit save via `onSave`                |
| **immediate mode**    | Each edit persisted immediately via `onChange`                                    |
| **validateConfig**    | Post-load coercion + range clamping function                                      |
| **ConfigManager**     | Declarative manager (`@k0valik/pi-base`) that wraps load + modal + save           |
| **depth**             | Visual nesting level (`FieldBase.depth`) for grouping related rows                |
| **visibleWhen**       | Conditional row visibility based on sibling values and scope                      |
| **valueDescriptions** | Per-value help text shown under the focused row for boolean/enum/number           |
| **step**              | Arrow-key cycling step for ranged NumberFields                                    |
| **validation**        | Per-field type-check via `validateFieldValue()` with warning display in the modal |
| **reset scope**       | Remove known config keys to restore defaults (preserves unknown keys)             |
| **delete scope**      | Remove the entire config file for a scope                                         |

---

## Part 1: Config Pattern

### 1.1 ConfigManager — the modern approach

Use `ConfigManager<T>` instead of manual `openSettingsModal` + `saveConfigScoped`.
Declare the schema; the manager owns loading, validation, diff-based save, modal
wiring, scope actions, and env overrides.

```ts
// <pkg>/src/config.ts
import { ConfigManager } from "@k0valik/pi-base";
import type { Field } from "@k0valik/pi-base";

export interface PkgConfig {
  enabled: boolean;
  threshold: number;
  backend: string;
}

export const DEFAULTS: PkgConfig = {
  enabled: true,
  threshold: 5,
  backend: "auto",
};

export const config = new ConfigManager<PkgConfig>({
  id: "<pkg>",
  label: "@k0valik/<pkg>",
  filename: "<pkg>-config.json",
  defaults: DEFAULTS,
  fields: (cfg) => [
    {
      key: "enabled",
      type: "boolean",
      label: "Enabled",
      description: "Master on/off switch.",
      value: cfg.enabled,
      valueDescriptions: { on: "Active and processing events", off: "Suspended" },
    },
    {
      key: "threshold",
      type: "number",
      label: "Threshold",
      description: "Processing threshold.",
      value: cfg.threshold,
      min: 1,
      max: 10,
      step: 1,
    },
    {
      key: "backend",
      type: "enum",
      label: "Backend",
      description: "Processing backend.",
      value: cfg.backend,
      options: ["auto", "strict", "fast"],
      optionLabels: {
        auto: "auto — pick best (default)",
        strict: "strict — highest accuracy",
        fast: "fast — lowest latency",
      },
    },
  ],
  validate: (raw) => ({
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULTS.enabled,
    threshold:
      typeof raw.threshold === "number" && Number.isFinite(raw.threshold)
        ? Math.min(10, Math.max(1, raw.threshold))
        : DEFAULTS.threshold,
    backend: typeof raw.backend === "string" ? raw.backend : DEFAULTS.backend,
  }),
  env: { threshold: "PI_PKG_THRESHOLD" },
});
```

### 1.2 Command wiring

```ts
// <pkg>/src/commands.ts
pi.registerCommand("<pkg>:config", {
  description: "Configure <pkg>",
  handler: async (_args, ctx) => {
    await config.openSettings(ctx, ctx.cwd, (updated) => {
      state.config = updated;
    });
  },
});
```

### 1.3 What ConfigManager handles automatically

| Concern                          | Manual pattern                      | ConfigManager                              |
| -------------------------------- | ----------------------------------- | ------------------------------------------ |
| Loading (default→global→project) | `loadConfig()` + `validateConfig()` | `config.load(cwd)`                         |
| Diff-based save                  | Write full object                   | Writes only fields differing from defaults |
| Modal wiring                     | `openSettingsModal({…})`            | `config.openSettings(ctx, cwd, cb)`        |
| Scope tabs                       | Must set `configFilename` manually  | Automatic from `filename`                  |
| Reset scope                      | Manual file read+write              | `config.resetScope(scope, cwd)`            |
| Delete scope                     | Manual `deleteConfig()`             | `config.deleteScope(scope, cwd)`           |
| Env overrides                    | Manual `readBooleanEnv()` calls     | Declarative `env` map                      |
| Malformed JSON warning           | Manual pre-check                    | Automatic via `warnOnMalformedConfig`      |
| Load-time validation             | Manual in `loadConfig`              | Calls your `validate` after load           |

### 1.4 Diff-based save

ConfigManager writes only fields whose value differs from `DEFAULTS`.
If no field differs from defaults, no file is written at all.

---

## Part 2: Modal as a General-Purpose UI Surface

The modal system is not config-only. It is a navigable list component that any
extension can mount for pickers, selectors, action menus, and any UI that needs
keyboard-driven row navigation with optional search, inline editing, and scope tabs.

### 2.1 Three API layers

| Layer       | Function                                 | Purpose                                                                                                                   | When to use                                                                                           |
| ----------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Body**    | `createSettingsModalBody(options, args)` | Low-level: renders the list component. Mount it directly into any `ctx.ui.custom` component.                              | You manage overlay/focus yourself, or you're embedding the list inside a larger custom component.     |
| **Factory** | `createSettingsModal(ctx, options)`      | Returns a `SettingsModalFactory` — a `(tui, theme, kb, done) => Component` function compatible with `ctx.ui.custom(...)`. | You want a modal with custom overlay lifecycle, or you're composing it inside another component tree. |
| **Overlay** | `openSettingsModal(ctx, options)`        | Opens a centered overlay, resolves on close.                                                                              | Happy path for config commands and simple pickers.                                                    |

**Key point:** `createSettingsModal` is a `ctx.ui.custom`-compatible factory. You can
mount it alongside other components, pass it to `container.addChild(...)`, or use
it as a sub-panel inside a larger TUI layout. It is not locked to config.

### 2.2 The Field system is general-purpose

Every row in the modal is a `Field`. The same field types that render config settings
also render any navigable row list:

| Field type | Renders                          | Use for                                |
| ---------- | -------------------------------- | -------------------------------------- |
| `boolean`  | Toggleable on/off row            | Feature flags, enable/disable items    |
| `enum`     | Cycling value or submenu list    | Mode selectors, category pickers       |
| `string`   | Inline-editable text row         | Labels, names, paths                   |
| `text`     | Submenu editor                   | Multi-line content                     |
| `number`   | Inline-editable / cycling number | Counts, sizes, thresholds              |
| `action`   | Activate-on-Enter row            | Buttons, commands, destructive actions |
| `custom`   | Bespoke renderer                 | Anything the built-ins don't cover     |

**pi-files-touched** handrolls a `SelectList` action picker with custom frame rendering:

```ts
// pi-files-touched/src/files-actions.ts — handrolled pattern
const selectList = new SelectList(mappedActions, mappedActions.length, { ... });
selectList.onSelect = (item) => done(item.value);
// ... manual frame, hints, responsive sizing
```

This could be a `createSettingsModalBody` call with `action` fields:

```ts
// Equivalent using the modal system
await openSettingsModal(ctx, {
  title: "File Action",
  fields: [
    {
      key: "diff",
      type: "action",
      label: "Diff in VS Code",
      display: "Diff",
      onActivate: () => "diff",
    },
    {
      key: "reveal",
      type: "action",
      label: "Reveal in Finder",
      display: "Reveal",
      onActivate: () => "reveal",
    },
    { key: "open", type: "action", label: "Open", display: "Open", onActivate: () => "open" },
    { key: "edit", type: "action", label: "Edit", display: "Edit", onActivate: () => "edit" },
  ],
  mode: "immediate",
  onChange: (_key, _value, field) => {
    done((field as { onActivate: () => string }).onActivate());
  },
});
```

The modal gives you for free: keyboard navigation, hint footer, frame chrome,
responsive sizing, and consistent keybindings. No handrolled `SelectList` needed.

### 2.3 `enableSearch` — fuzzy search UX

Set `enableSearch: true` in `SettingsModalOptions` to render a search bar above
the field list. The search bar is context-aware:

- **Empty:** shows placeholder `"Search settings..."`, footer hints `type to search`
- **Typing:** filters rows by fuzzy match against `label`, `description`, and `key`
- **No matches:** query renders in warning color, empty-state message shown
- **Escape (first press):** clears the search query if populated, footer hints switch to `esc clear search`
- **Escape (second press):** closes the modal (or shows confirm if buffered + dirty)
- **Ctrl+U:** clears the entire search query
- **Ctrl+W:** deletes the word before the cursor

Search is integrated with the field navigation: when the query changes, selection
resets to the first match, and the list scrolls to reveal it.

**When to use:** configs with >8 fields, any picker with >6 items, or any list
where the user might need to jump to a specific row by name.

### 2.4 Non-config usage pattern

The modal does not require `configFilename`, scope tabs, or buffered mode. The
minimal picker pattern:

```ts
await openSettingsModal(ctx, {
  title: "Choose an action",
  fields: [
    { key: "a", type: "action", label: "Option A", onActivate: () => "a" },
    { key: "b", type: "action", label: "Option B", onActivate: () => "b" },
  ],
  mode: "immediate",
  onChange: (_key, _value, field) => {
    done((field as { onActivate: () => string }).onActivate());
  },
});
```

Or mount it as a sub-component inside a larger `ctx.ui.custom` layout:

```ts
const picker = createSettingsModal(ctx, {
  title: "Pick one",
  fields: [...],
  mode: "immediate",
  onChange: (key, value) => { ... },
});

return {
  render(width) { ... },
  handleInput(data) { picker(tui, theme, kb, done).handleInput?.(data); },
};
```

### 2.5 `frame.ts` utilities are public building blocks

`packages/pi-base/src/settings/frame.ts` exports utilities used by the modal
**and** by handrolled components like pi-files-touched:

| Export                                                         | Purpose                                                                 |
| -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `frame(lines, width, theme, opts?)`                            | Wrap lines in a rounded-light frame with title bar, border, and padding |
| `frameContentWidth(width)`                                     | Inner content width given an outer frame width                          |
| `pad(text, width)`                                             | Right-pad a string to exactly `width` columns (handles ANSI)            |
| `wrapLine(line, width)`                                        | Wrap a possibly-ANSI-coloured line to fit `width`                       |
| `divider(width, theme)`                                        | Render a horizontal divider in `dim`                                    |
| `formatHintLine(hints, theme)`                                 | Format key-hint pairs as a single footer line                           |
| `responsiveInnerRows(terminalRows, preferred, minimum, ratio)` | Compute inner row count from terminal height                            |

These are the utilities pi-files-touched already uses. They're public — import
them directly when you need a frame without the full field/modal machinery.

### 2.6 Upstream primitives from `@earendil-works/pi-tui`

pi-base wraps these upstream components. Know what's already available before
handrolling:

| Export                                    | Purpose                                                            | pi-base usage                             |
| ----------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------- |
| `Component`                               | `{ render(width): string[]; handleInput?(data); invalidate?() }`   | Modal body, all custom components         |
| `TUI`                                     | Terminal UI engine — render loop, input dispatch, focus management | Passed to every `ctx.ui.custom` factory   |
| `Theme`                                   | `fg(role, text)`, `bg(role, text)`, `inverse(text)`, `bold(text)`  | All styling goes through theme            |
| `matchesKey(data, name)`                  | Match escape sequences to key names (`"ctrl+s"`, `"alt+up"`, etc.) | Every input handler                       |
| `Key`                                     | Key-name constants (`Key.ctrl("s")`, etc.)                         | Keybinding definitions                    |
| `Input`                                   | Single-line text input component                                   | Used in string/text submenus              |
| `Editor`                                  | Multi-line editor component                                        | Used in `text` field submenu              |
| `SelectList`                              | Scrollable single/multi-select list                                | Used in `enum` cycling + `string` submenu |
| `SettingsList`                            | Simple boolean toggle list                                         | Used by pi-skills (upstream, not pi-base) |
| `Container`                               | Layout container for composing child components                    | Advanced layouts                          |
| `truncateToWidth(text, width, ellipsis?)` | Truncate to terminal width (handles ANSI)                          | Row rendering                             |
| `wrapTextWithAnsi(text, width)`           | Wrap text preserving ANSI styles                                   | Description rendering                     |
| `visibleWidth(text)`                      | Visible character width (ANSI-aware)                               | Label width calculation                   |

**Anti-pattern:** importing `SelectList` and handrolling a frame/hints/responsive
layout around it when `createSettingsModalBody` with `action` fields already does
all of that.

---

## Part 3: Config Pattern — Implementation Details

### 3.1 Define config shape

```ts
// <pkg>/src/config.ts

export const CONFIG_FILENAME = "<pkg>-config.json";

export interface PkgConfig {
  enabled: boolean;
  backend: string;
  threshold: number;
}

export const DEFAULTS: PkgConfig = {
  enabled: true,
  backend: "auto",
  threshold: 5.5,
};
```

**Rules:**

- One `CONFIG_FILENAME` constant, exported, used everywhere.
- One `DEFAULTS` object, exported, used as the `loadConfig` fallback and passed as
  `defaults` to the modal.
- Interface covers the full shape. No `Partial` in the public type.

### 3.2 Load config

```ts
import { loadConfig as loadSharedConfig } from "@k0valik/pi-base";

export function loadConfig(cwd?: string): PkgConfig {
  const loaded = loadSharedConfig<Partial<PkgConfig>>(CONFIG_FILENAME, DEFAULTS, {
    cwd,
    merge: "deep",
  });
  return validateConfig(loaded as Record<string, unknown>);
}
```

**Rules:**

- Single call to `loadSharedConfig`. Pass `cwd` for project-local override.
- Use `merge: "deep"` for nested configs. Use shallow (default) for flat configs.
- Always pipe through `validateConfig` for type coercion and range clamping.
- Never call `loadConfig` twice (no global-only pass then project pass). The deep merge handles both layers.

### 3.3 Validate config

```ts
export function validateConfig(raw: Record<string, unknown>): PkgConfig {
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULTS.enabled,
    backend: typeof raw.backend === "string" ? raw.backend : DEFAULTS.backend,
    threshold:
      typeof raw.threshold === "number" && Number.isFinite(raw.threshold)
        ? Math.min(10, Math.max(1, raw.threshold))
        : DEFAULTS.threshold,
  };
}
```

**Rules:**

- Accepts `Record<string, unknown>` — the shape returned by `loadConfig` after JSON parse.
- Coerces each property with `typeof` checks. Falls back to `DEFAULTS` on type mismatch.
- Clamps numeric ranges inline. No magic numbers outside this function.
- Returns the fully typed `PkgConfig`. Never returns `Partial<T>`.
- Call `validateConfig` after `loadConfig` and after merging modal values.

**Env overrides:** apply **after** `validateConfig`, not before. Env is Layer 4.

```ts
config.threshold = readPositiveIntEnv("PI_PKG_THRESHOLD", config.threshold);
```

### 3.4 Save config

```ts
import { writeConfig, getExtensionsDir } from "@k0valik/pi-base";

export async function saveConfigScoped(
  config: PkgConfig,
  scope: "global" | "project",
  cwd: string,
): Promise<void> {
  const dir = scope === "project" ? `${cwd}/.pi` : getExtensionsDir();
  writeConfig(CONFIG_FILENAME, config, dir);
}
```

**Rules:**

- Write the full validated config object. No read→merge→write patch dance.
- The modal already has all field values; re-reading from disk is wasted I/O.
- Return `Promise<void>` or `boolean` consistently across the codebase.

**What NOT to do:**

- Do not `deepMerge` existing + patch before writing.
- Do not call `loadConfig` inside `saveConfigScoped`. That's a circular dependency.

### 3.5 Wire the modal (manual pattern)

```ts
import { openSettingsModal, type Field } from "@k0valik/pi-base/settings";
import { existsSync } from "node:fs";
import { join } from "node:path";

export async function openPkgSettings(ctx: ExtensionContext, state: RuntimeState): Promise<void> {
  const config = loadConfig(ctx.cwd);

  const fields: Field[] = [
    {
      key: "enabled",
      type: "boolean",
      label: "Enabled",
      description: "Master on/off switch.",
      value: config.enabled,
    },
    // ...more fields
  ];

  await openSettingsModal(ctx, {
    title: "@k0valik/<pkg>",
    configFilename: CONFIG_FILENAME, // enables Global/Project scope tabs
    mode: "buffered", // persist on explicit save only
    inferDefaultScope: () =>
      existsSync(join(ctx.cwd, ".pi", CONFIG_FILENAME)) ? "project" : "global",
    fields,
    onSave: async (values, scope) => {
      const updated = validateConfig(values as Record<string, unknown>);
      await saveConfigScoped(updated, scope, ctx.cwd);
      state.config = updated; // direct state update, no disk reload
    },
  });
}
```

**Rules:**

- Always pass `configFilename`. This enables Global/Project scope tabs. Without it, the modal has no scope awareness.
- Always pass `mode: "buffered"`. Immediate mode is for live-preview. Config persistence is not live-preview.
- Always pass `inferDefaultScope`. Use `existsSync` on `<cwd>/.pi/<configFilename>`.
- Always pass `title`.
- `onSave` receives flat `values: Record<string, unknown>`. Validate, then write. Then update in-memory state directly. Do not re-read from disk.

### 3.6 Field key conventions

| Convention   | Example                                  | When to use                                                                                                                                        |
| ------------ | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Flat         | `"enabled"`, `"backend"`                 | Default. Works with and without `configFilename`.                                                                                                  |
| Dot-notation | `"channels.terminal"`, `"sound.backend"` | Only when `configFilename` is set and you want the modal to read/write nested values from the loaded config objects natively via `getNestedValue`. |

**Do not use underscore-separated keys** (`"components_spinner"`). This requires manual flattening/reconstruction in `onSave`.

---

## Part 4: Writing Good Fields

### 4.1 Descriptions and option labels

Field `description` and enum `optionLabels` are the only inline documentation the user sees inside the modal. Treat them as user-facing copy.

```ts
{
  key: "entropyThreshold",
  type: "number",
  label: "Entropy Threshold",
  description: "Shannon entropy cutoff for high-entropy token detection. Lower = more aggressive redaction.",
  value: config.entropyThreshold,
  min: 1,
  max: 10,
}
```

**Rules for descriptions:**

- One sentence. What the setting controls and what happens when you change it.
- Reference actual behavior, not the variable name.
- Mention defaults when non-obvious: "(default: 5.5)" or "(requires /reload)".
- Mention side effects: reload requirements, performance cost, scope interaction.
- Omit description only when the label is self-explanatory (e.g. "Enabled").

```ts
{
  key: "mode",
  type: "enum",
  label: "Mode",
  description: "What to do when a secret pattern matches.",
  value: config.mode,
  options: ["strict", "redact-only", "off"],
  optionLabels: {
    strict: "strict — redact + block risky ops",
    "redact-only": "redact-only (default) — redact only, no blocking",
    off: "off — disabled",
  },
}
```

**Rules for optionLabels:**

- Every option should have a label.
- Mark the default in the label: `(default)`.
- One-line behavioral summary per option.

### 4.2 Conditional visibility

```ts
{
  key: "entropyThreshold",
  type: "number",
  label: "Entropy Threshold",
  value: 5.5,
  visibleWhen: (ctx) => ctx.get("enableEntropy") === true,
}
```

`ctx` provides:

- `get(key)` — read the resolved (merged) value of a sibling field
- `getScoped(key, scope?)` — read a value from a specific scope
- `scope` — the current scope (`"global"` or `"project"`)

### 4.3 Depth grouping

```ts
{ key: "terminal",    type: "string", label: "Terminal",    value: "", depth: 0 },
{ key: "terminal.header", type: "boolean", label: "Show header", value: true, depth: 1 },
{ key: "terminal.footer", type: "boolean", label: "Show footer", value: true, depth: 1 },
```

### 4.4 Reorderable rows

```ts
{ key: "first",  type: "string", label: "First item",  value: "a", reorderable: true },
{ key: "second", type: "string", label: "Second item", value: "b", reorderable: true },
```

Set `reorderable: true` on rows that should move with `alt+↑` / `alt+↓`. Group
reorderable rows contiguously — the modal only swaps with the immediate neighbour.

### 4.5 Field types reference

| Type      | `value` type | Editing             | Use for                                                | Extra options                                                  |
| --------- | ------------ | ------------------- | ------------------------------------------------------ | -------------------------------------------------------------- |
| `boolean` | `boolean`    | Toggle              | Flags, toggles                                         | `valueDescriptions: { on?, off? }`                             |
| `enum`    | `T`          | Cycle / SelectList  | Fixed-choice selects                                   | `optionLabels`, `cycleThreshold`                               |
| `string`  | `string`     | Inline edit         | Single-line free text                                  | —                                                              |
| `text`    | `string`     | Submenu (Editor)    | Multi-line free text                                   | —                                                              |
| `number`  | `number`     | Inline edit / Cycle | Numeric values; cycling when `values` or `step` is set | `min`, `max`, `integer`, `step`, `values`, `valueDescriptions` |
| `secret`  | `string`     | Masked edit         | Passwords, tokens                                      | —                                                              |
| `path`    | `string`     | Path picker         | Filesystem paths                                       | —                                                              |
| `model`   | `ModelValue` | Submenu             | Provider/model + thinking level                        | `sessionLabel`, `filter`, `hideEffort`                         |
| `action`  | —            | Activate on Enter   | Run a command / return a value from the modal          | `display`, `onActivate`                                        |
| `custom`  | `T`          | Custom              | Escape hatch for bespoke widgets                       | `render`, `handleInput`, `openSubmenu`, `hints`                |

**Common options across all field types (`FieldBase`):**

| Option           | Type                                  | Purpose                                              |
| ---------------- | ------------------------------------- | ---------------------------------------------------- |
| `depth`          | `number`                              | Visual indent (`depth * 2` spaces)                   |
| `visibleWhen`    | `(ctx: VisibilityContext) => boolean` | Conditionally hide row                               |
| `description`    | `string`                              | Help text under the focused row                      |
| `disabled`       | `boolean`                             | Row visible but not interactive                      |
| `dim`            | `boolean \| () => boolean`            | Override label color regardless of focus             |
| `requiresReload` | `boolean`                             | Show hint in confirm prompt that `/reload` is needed |
| `reorderable`    | `boolean`                             | Enable alt+↑/↓ reorder                               |
| `default`        | `unknown`                             | Value used for field-level reset (`alt+r`)           |

---

## Part 5: Validation & Scope Actions

### 5.1 Field validation

The modal displays per-field validation warnings in the focused-row description area.

```ts
import { validateFieldValue } from "@k0valik/pi-base/settings";

const warning = validateFieldValue(field, someValue);
if (warning) {
  ctx.ui.notify(`"${field.label}": ${warning}`, "warning");
}
```

**Automatic type checks:**

| Type      | Validates                                                                                |
| --------- | ---------------------------------------------------------------------------------------- |
| `enum`    | Value is a string in `options`                                                           |
| `boolean` | Value is a boolean                                                                       |
| `string`  | Value is a string, no newlines                                                           |
| `text`    | Value is a string                                                                        |
| `number`  | Finite number, `integer` check, `min`/`max` range, `values` membership, `step` alignment |
| `secret`  | Value is a string                                                                        |
| `path`    | Value is a string                                                                        |
| `model`   | Value is an object with a string `id`                                                    |

### 5.2 Scope actions (Reset / Delete)

The modal shows action rows at the bottom of each scope tab when `onResetScope`
and/or `onDeleteScope` callbacks are provided.

| Action           | What it does                   | Unknown keys |
| ---------------- | ------------------------------ | ------------ |
| **Reset scope**  | Removes all known config keys  | Preserved    |
| **Delete scope** | Removes the entire config file | Removed      |

**ConfigManager wiring** — both actions are wired automatically:

```ts
await config.openSettings(ctx, ctx.cwd, (updated) => {
  state.config = updated;
});
```

**Manual wiring:**

```ts
await openSettingsModal(ctx, {
  // … other options …
  onResetScope: async (scope) => {
    const dir = scope === "project" ? `${cwd}/.pi` : getExtensionsDir();
    deleteConfig(CONFIG_FILENAME, dir);
  },
  onDeleteScope: async (scope) => {
    const dir = scope === "project" ? `${cwd}/.pi` : getExtensionsDir();
    deleteConfig(CONFIG_FILENAME, dir);
  },
});
```

After either action, the modal reloads configs and updates all rows with fresh values.

---

## Part 6: Post-Save, Env Overrides, and Commands

### 6.1 Post-save state update

```ts
onSave: async (values, scope) => {
  const updated = validateConfig(values as Record<string, unknown>);
  await saveConfigScoped(updated, scope, ctx.cwd);
  state.config = updated;
},
```

**Rules:**

- Update in-memory state directly from the validated object.
- Do not call `loadConfig()` after save. That reads from disk, which may have stale data or silently re-apply env overrides.
- If the extension has runtime side-effects (title re-application, spinner restart), trigger them here after updating state.

### 6.2 Env override pattern

```ts
// Layer 4: env vars override file config
config.threshold = readPositiveIntEnv("PI_PKG_THRESHOLD", config.threshold);
config.mode = parseMode(process.env.PI_PKG_MODE) ?? config.mode;
```

**Rules:**

- Apply env overrides after `validateConfig`, after modal merge, after `loadConfig`.
- Env overrides are not editable in the modal. They're a deployment-time escape hatch.
- Document env vars in the extension's README, not in the modal.

### 6.3 Command wiring

Standard three-command pattern:

```ts
// Toggle command — writes to global scope
pi.registerCommand("<pkg>", {
  description: "Description of what the command does.",
  handler: async (args, ctx) => {
    const sub = args.trim().toLowerCase();
    switch (sub) {
      case "on": {
        const config = loadConfig(ctx.cwd);
        config.enabled = true;
        await saveConfigScoped(config, "global", ctx.cwd);
        ctx.ui.notify("<pkg>: enabled", "info");
        break;
      }
      case "off": {
        const config = loadConfig(ctx.cwd);
        config.enabled = false;
        await saveConfigScoped(config, "global", ctx.cwd);
        ctx.ui.notify("<pkg>: disabled", "info");
        break;
      }
      default: {
        const config = loadConfig(ctx.cwd);
        ctx.ui.notify(`<pkg>: enabled=${config.enabled} ...`, "info");
      }
    }
  },
});

// Config command — opens the modal
pi.registerCommand("<pkg>:config", {
  description: "Show config options for <pkg>",
  handler: async (_args, ctx) => {
    await openPkgSettings(ctx, state);
  },
});
```

**Rules:**

- The toggle command writes to **global** scope.
- The config command opens the settings modal with full scope selection.

---

## Part 7: Modal Options Reference

Every option the modal accepts, when to set it, and why.

| Option              | Type                                       | Required       | Default           | Purpose                                                                                                                      |
| ------------------- | ------------------------------------------ | -------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `title`             | `string`                                   | yes            | —                 | Frame title. Use `@k0valik/<pkg>`.                                                                                           |
| `configFilename`    | `string`                                   | no             | —                 | Enables Global/Project scope tabs. Modal loads both configs and shows per-scope values. Only needed for config modals.       |
| `mode`              | `"immediate" \| "buffered"`                | yes            | `"immediate"`     | Use `"buffered"` for config. Use `"immediate"` for pickers/selectors.                                                        |
| `inferDefaultScope` | `() => "global" \| "project"`              | no             | `"global"`        | Pre-selects scope tab. Only relevant when `configFilename` is set.                                                           |
| `fields`            | `Field[]`                                  | yes            | —                 | Field rows. See field types above.                                                                                           |
| `defaults`          | `Record<string, unknown>`                  | no             | `{}`              | Modal's built-in defaults for reset (`alt+r`) and missing-value fallback. Pass `DEFAULTS` cast to `Record<string, unknown>`. |
| `onSave`            | `(values, scope) => void \| Promise<void>` | buffered only  | —                 | Receives all field values + chosen scope. Validate, persist, update state.                                                   |
| `onChange`          | `(key, value, field) => void`              | immediate only | —                 | Per-field callback. Not needed in buffered mode.                                                                             |
| `onCancel`          | `() => void`                               | no             | —                 | Called on discard. Usually no-op.                                                                                            |
| `onClose`           | `() => void`                               | no             | —                 | Called on modal dismiss. Cleanup hook.                                                                                       |
| `onReorder`         | `(info) => void`                           | no             | —                 | Mirror reorderable row swaps into persistent state.                                                                          |
| `initialTab`        | `string`                                   | no             | first tab         | Override initial tab. Usually not needed if `inferDefaultScope` is set.                                                      |
| `tabs`              | `Tab[]`                                    | no             | —                 | Custom tab strip. Not needed when using `configFilename` (modal auto-generates Global/Project tabs).                         |
| `enableSearch`      | `boolean`                                  | no             | `false`           | Fuzzy search bar. Useful for configs with >8 fields and any picker with >6 items.                                            |
| `theme`             | `SettingsTheme`                            | no             | —                 | Color overrides. Rarely needed.                                                                                              |
| `overlayOptions`    | `OverlayOptions`                           | no             | centered, 92%×85% | Positioning override. Rarely needed.                                                                                         |

---

## Part 8: Anti-Patterns

| Anti-pattern                                                         | What happens                                                                  | Fix                                                                                                                                 |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Double-load (`loadConfig` for global, then `loadConfig` for project) | Redundant I/O, manual merge logic                                             | Single `loadConfig` call with `cwd` + `merge: "deep"`                                                                               |
| Patch-based save (read→deepMerge→write)                              | Wasted disk read, stale data risk                                             | Write full config from modal `values`                                                                                               |
| Underscore-separated field keys                                      | Manual flatten/reconstruction in `onSave`                                     | Use flat keys or dot-notation with `configFilename`                                                                                 |
| Missing `configFilename` in modal                                    | No scope tabs, no per-scope value display                                     | Always pass `configFilename` when you need scope awareness                                                                          |
| Reload from disk after save                                          | Silently re-applies env overrides, reverts user choices                       | Update state directly from validated `values`                                                                                       |
| Handrolling SelectList + frame + hints                               | Reimplements navigation, search, responsive sizing, footer, keyboard handling | Use `createSettingsModalBody` / `openSettingsModal` with `action` fields. See §2.2.                                                 |
| Using upstream `SettingsList` for config                             | No scope tabs, no typed fields, no buffered mode, no custom renderers         | Use `createSettingsModal` — strictly more capable in every dimension. `SettingsList` is a simple upstream boolean toggle list only. |
| Immediate mode for config                                            | Each keystroke writes to disk, no scope selection                             | Use `mode: "buffered"`                                                                                                              |
| Security double-load (project can't override X)                      | Overkill for standard configs                                                 | Only add security layer if the config controls command execution or file paths.                                                     |
| `readConfig` + shallow spread instead of `loadConfig`                | Misses built-in deep merge                                                    | Use `loadConfig` with `merge: "deep"`                                                                                               |

---

## Minimal Complete Example

```ts
// <pkg>/src/config.ts
import {
  loadConfig as loadSharedConfig,
  writeConfig,
  getExtensionsDir,
  readBooleanEnv,
} from "@k0valik/pi-base";

export const CONFIG_FILENAME = "<pkg>-config.json";

export interface PkgConfig {
  enabled: boolean;
  backend: string;
  threshold: number;
}

export const DEFAULTS: PkgConfig = {
  enabled: true,
  backend: "auto",
  threshold: 5.5,
};

export function validateConfig(raw: Record<string, unknown>): PkgConfig {
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULTS.enabled,
    backend: typeof raw.backend === "string" ? raw.backend : DEFAULTS.backend,
    threshold:
      typeof raw.threshold === "number" && Number.isFinite(raw.threshold)
        ? Math.min(10, Math.max(1, raw.threshold))
        : DEFAULTS.threshold,
  };
}

export function loadConfig(cwd?: string): PkgConfig {
  const loaded = loadSharedConfig<Partial<PkgConfig>>(CONFIG_FILENAME, DEFAULTS, {
    cwd,
    merge: "deep",
  });
  const config = validateConfig(loaded as Record<string, unknown>);
  config.backend = process.env.PI_PKG_BACKEND?.trim() || config.backend;
  return config;
}

export async function saveConfigScoped(
  config: PkgConfig,
  scope: "global" | "project",
  cwd: string,
): Promise<void> {
  const dir = scope === "project" ? `${cwd}/.pi` : getExtensionsDir();
  writeConfig(CONFIG_FILENAME, config, dir);
}
```

```ts
// <pkg>/src/commands.ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { openSettingsModal, type Field } from "@k0valik/pi-base/settings";
import {
  loadConfig,
  saveConfigScoped,
  CONFIG_FILENAME,
  DEFAULTS,
  validateConfig,
} from "./config.ts";

export async function openSettings(extCtx: ExtensionContext, state: RuntimeState): Promise<void> {
  const config = loadConfig(extCtx.cwd);

  const fields: Field[] = [
    {
      key: "enabled",
      type: "boolean",
      label: "Enabled",
      description: "Master on/off switch.",
      value: config.enabled,
    },
    {
      key: "backend",
      type: "enum",
      label: "Backend",
      description: "Processing backend.",
      value: config.backend,
      options: ["auto", "strict", "fast"],
    },
    {
      key: "threshold",
      type: "number",
      label: "Threshold",
      description: "Processing threshold (1–10).",
      value: config.threshold,
      min: 1,
      max: 10,
    },
  ];

  await openSettingsModal(extCtx, {
    title: "@k0valik/<pkg>",
    configFilename: CONFIG_FILENAME,
    mode: "buffered",
    defaults: DEFAULTS as unknown as Record<string, unknown>,
    inferDefaultScope: () =>
      existsSync(join(extCtx.cwd, ".pi", CONFIG_FILENAME)) ? "project" : "global",
    fields,
    onSave: async (values, scope) => {
      const updated = validateConfig(values as Record<string, unknown>);
      await saveConfigScoped(updated, scope, extCtx.cwd);
      state.config = updated;
    },
  });
}
```

---

## Appendix A: Layering — Upstream → pi-base → Consumer

Understanding the three layers prevents handrolling.

### A.1 `@earendil-works/pi-tui` (upstream — bundled, no TS source)

Low-level TUI primitives. Import these when you need the raw building block:

- **Components:** `Text`, `Input`, `Editor`, `SelectList`, `SettingsList`, `Container`
- **Utilities:** `matchesKey`, `Key`, `truncateToWidth`, `wrapTextWithAnsi`, `visibleWidth`
- **Types:** `Component`, `TUI`, `Theme`, `SelectItem`, `SelectListTheme`

pi-base re-exports/wraps these. You almost never need to import `pi-tui` directly
in an extension — go through `@k0valik/pi-base`.

### A.2 `@earendil-works/pi-coding-agent` (upstream — bundled, no TS source)

Extension API types and platform utilities:

- **Types:** `ExtensionContext`, `Theme`
- **Utilities:** `getAgentDir`, `getSelectListTheme`, `getSettingsListTheme`

### A.3 `@k0valik/pi-base` (this repo — TypeScript source)

The consolidation layer. Import from here instead of handrolling:

| Category               | Exports                                                                                             | Purpose                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| **Config I/O**         | `loadConfig`, `writeConfig`, `deleteConfig`, `readConfig`, `deepMerge`, `getExtensionsDir`          | Layered config loading, atomic writes, deep merge |
| **Config validation**  | `readBooleanEnv`, `readPositiveIntEnv`                                                              | Env override parsing                              |
| **Settings modal**     | `openSettingsModal`, `createSettingsModal`, `createSettingsModalBody`                               | Full modal system (overlay, factory, body)        |
| **Settings types**     | `Field`, `SettingsModalOptions`, `Tab`, `SettingsTheme`, all field variant types                    | Typed field definitions                           |
| **Field renderers**    | `RENDERERS` map, individual field modules                                                           | Built-in renderers for every field type           |
| **Frame utilities**    | `frame`, `pad`, `wrapLine`, `divider`, `formatHintLine`, `frameContentWidth`, `responsiveInnerRows` | Frame chrome, hint formatting, responsive sizing  |
| **Inline edit**        | `InlineEditState`, `createInputSubmenu`                                                             | Inline text editing inside fields                 |
| **ConfigManager**      | `ConfigManager` class                                                                               | Declarative config + modal wiring                 |
| **Settings registry**  | `registerSettings`, `getRegisteredSettings`, `registerConfigSettings`                               | Central settings discovery                        |
| **Session registries** | `createRegistry`, `createSessionStateRegistry`                                                      | Symbol-based global/per-session state             |

### A.4 Where pi-files-touched fits

pi-files-touched uses pi-base's `frame.ts` utilities (`frameContentWidth`,
`responsiveInnerRows`, `formatHintLine`) but handrolls its own selector with
upstream `SelectList`. It does not use config, so it doesn't need the modal's
scope-tab machinery — but it still benefits from `createSettingsModalBody` with
`action` fields for consistent keyboard nav, hints, and frame rendering.

---

## Appendix B: Canonical Implementation Reference

This appendix documents how pi-redact-secrets implements every facet of the
canonical config pattern. It serves as the migration reference for every other
package.

### B.1 File inventory

| File                             | Responsibility                                                    |
| -------------------------------- | ----------------------------------------------------------------- |
| `src/types.ts`                   | Config type, runtime state type, constants, notification messages |
| `src/config.ts`                  | Config loading, validation, saving, env overrides                 |
| `src/commands/redact-secrets.ts` | Command handlers + modal wiring                                   |
| `src/index.ts`                   | Extension entry point, event hooks, command registration          |

**Rule:** one file per responsibility. `types.ts` holds the shape, `config.ts` holds
I/O and validation, `commands/*.ts` holds UI and command handlers, `index.ts` is
the thin entry point.

### B.2 `src/types.ts` — the type/constants layer

```ts
export type RedactSecretsMode = "strict" | "redact-only" | "off";

export type RedactSecretsConfig = {
  mode: RedactSecretsMode;
  allowPaths: string[];
  blockPaths: string[];
  prefixPreserve: boolean;
  enablePii: boolean;
  enableEntropy?: boolean;
  entropyThreshold?: number;
  minEntropyTokenLength?: number;
  enableEncodingDetection?: boolean;
  failClosed?: boolean;
};

export type RedactSecretsState = {
  mode: RedactSecretsMode;
  config: RedactSecretsConfig;
};

export const DEFAULT_MODE: RedactSecretsMode = "redact-only";

export function parseMode(input: string): RedactSecretsMode | undefined {
  const mode = input.trim().toLowerCase();
  return REDACT_SECRETS_MODES.has(mode as RedactSecretsMode)
    ? (mode as RedactSecretsMode)
    : undefined;
}
```

**Good patterns:**

- Config type and State type are separate. Some fields belong in state but never in config.
- Optional properties with `DEFAULTS` fallbacks for backward-compatible config evolution.
- Domain validation functions live next to the type they constrain.
- Notification messages as a constant map.

**Inconsistency to fix:** `CONFIG_FILENAME` is duplicated in `types.ts` and `config.ts`.
Define it once in `config.ts` and re-export from there.

### B.3 `src/config.ts` — the config module

```ts
export const CONFIG_FILENAME = "pi-redact-secrets-config.json";

export const DEFAULTS: RedactSecretsConfig = {
  mode: "redact-only",
  allowPaths: [],
  blockPaths: [],
  prefixPreserve: true,
  enablePii: false,
  enableEntropy: true,
  entropyThreshold: 5.5,
  minEntropyTokenLength: 32,
  enableEncodingDetection: false,
  failClosed: true,
};

function validatePathList(raw: unknown, fieldName: string): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item, index) => {
      if (typeof item !== "string" || !item.trim()) {
        throw new Error(`${fieldName}[${index}] must be a non-empty string`);
      }
      return item.trim();
    })
    .filter((item, index, self) => self.indexOf(item) === index);
}

export function validateConfig(raw: Record<string, unknown>): RedactSecretsConfig {
  const mode = typeof raw.mode === "string" ? raw.mode : DEFAULTS.mode;
  const parsedMode = typeof mode === "string" ? parseMode(mode) : undefined;

  return {
    mode: parsedMode ?? DEFAULTS.mode,
    allowPaths: validatePathList(raw.allowPaths, "allowPaths"),
    blockPaths: validatePathList(raw.blockPaths, "blockPaths"),
    prefixPreserve:
      typeof raw.prefixPreserve === "boolean" ? raw.prefixPreserve : DEFAULTS.prefixPreserve,
    enablePii: typeof raw.enablePii === "boolean" ? raw.enablePii : DEFAULTS.enablePii,
    enableEntropy:
      typeof raw.enableEntropy === "boolean" ? raw.enableEntropy : DEFAULTS.enableEntropy,
    entropyThreshold:
      typeof raw.entropyThreshold === "number" && Number.isFinite(raw.entropyThreshold)
        ? raw.entropyThreshold
        : DEFAULTS.entropyThreshold,
    minEntropyTokenLength:
      typeof raw.minEntropyTokenLength === "number" &&
      Number.isFinite(raw.minEntropyTokenLength) &&
      raw.minEntropyTokenLength > 0
        ? raw.minEntropyTokenLength
        : DEFAULTS.minEntropyTokenLength,
    enableEncodingDetection:
      typeof raw.enableEncodingDetection === "boolean"
        ? raw.enableEncodingDetection
        : DEFAULTS.enableEncodingDetection,
    failClosed: typeof raw.failClosed === "boolean" ? raw.failClosed : DEFAULTS.failClosed,
  };
}

export async function loadRedactSecretsConfig(cwd?: string): Promise<RedactSecretsConfig> {
  const loaded = loadConfig(CONFIG_FILENAME, DEFAULTS, { merge: "deep", cwd });
  const config = validateConfig(loaded as unknown as Record<string, unknown>);

  // Layer 4: env var overrides
  config.enablePii = readBooleanEnv(
    "PI_REDACT_SECRETS_ENABLE_PII",
    config.enablePii ?? DEFAULTS.enablePii,
  );
  config.prefixPreserve = readBooleanEnv(
    "PI_REDACT_SECRETS_PREFIX_PRESERVE",
    config.prefixPreserve ?? DEFAULTS.prefixPreserve,
  );
  config.enableEntropy = readBooleanEnv(
    "PI_REDACT_SECRETS_ENABLE_ENTROPY",
    (config.enableEntropy ?? DEFAULTS.enableEntropy) as boolean,
  );
  config.enableEncodingDetection = readBooleanEnv(
    "PI_REDACT_SECRETS_ENABLE_ENCODING_DETECTION",
    (config.enableEncodingDetection ?? DEFAULTS.enableEncodingDetection) as boolean,
  );

  const modeOverride = process.env.PI_REDACT_SECRETS_MODE;
  if (modeOverride) {
    const parsed = parseMode(modeOverride);
    if (parsed) config.mode = parsed;
  }

  const entropyThresholdEnv = parseFloat(process.env.PI_REDACT_SECRETS_ENTROPY_THRESHOLD ?? "");
  if (Number.isFinite(entropyThresholdEnv)) {
    config.entropyThreshold = Math.min(Math.max(entropyThresholdEnv, 1), 10);
  }

  config.minEntropyTokenLength = readPositiveIntEnv(
    "PI_REDACT_SECRETS_MIN_ENTROPY_LENGTH",
    (config.minEntropyTokenLength ?? DEFAULTS.minEntropyTokenLength) as number,
  );
  config.failClosed = readBooleanEnv(
    "PI_REDACT_SECRETS_FAIL_CLOSED",
    (config.failClosed ?? DEFAULTS.failClosed) as boolean,
  );

  return config;
}

export async function saveRedactSecretsConfigScoped(
  config: RedactSecretsConfig,
  scope: "global" | "project",
  cwd?: string,
): Promise<void> {
  if (scope === "project" && !cwd) {
    throw new Error("cwd is required for project-scoped config save");
  }
  const dir = scope === "project" ? `${cwd}/.pi` : getExtensionsDir();
  writeConfig(CONFIG_FILENAME, config, dir);
}
```

**Good patterns here:**

1. Single `loadConfig` call with `merge: "deep"`. One call handles defaults → global → project.
2. Domain-specific validators as private functions.
3. `validateConfig` accepts `Record<string, unknown>` and returns the fully typed config.
4. Env overrides applied AFTER `validateConfig`, as Layer 4.
5. `writeConfig` return value is `boolean` (vitest guard). In production it returns `true`.

### B.4 `src/commands/redact-secrets.ts` — command handlers and modal wiring

```ts
export async function handleConfigCommand(
  _args: string,
  ctx: any,
  cwd: string,
  state: RedactSecretsState,
): Promise<void> {
  const config = await loadRedactSecretsConfig(cwd);

  await openSettingsModal(ctx, {
    title: "pi-redact-secrets",
    configFilename: "pi-redact-secrets-config.json",
    mode: "buffered",
    inferDefaultScope: () => {
      const projectPath = join(cwd, ".pi", "pi-redact-secrets-config.json");
      return existsSync(projectPath) ? "project" : "global";
    },
    fields: [
      {
        key: "mode",
        label: "Mode",
        type: "enum",
        value: config.mode,
        options: ["strict", "redact-only", "off"],
        optionLabels: {
          strict: "strict (redact + block)",
          "redact-only": "redact-only (default)",
          off: "off (disabled)",
        },
      },
      // ... more fields
    ],
    onSave: async (values, scope) => {
      const merged = { ...config, ...values };
      const updated = validateConfig(merged as Record<string, unknown>);
      await saveRedactSecretsConfigScoped(updated, scope, cwd);
      state.config = updated;
      state.mode = updated.mode;
      notify(ctx, "pi-redact-secrets settings saved", "info");
    },
  });
}
```

**Good patterns:**

1. `onSave` does `{ ...config, ...values }` merge before validate — preserves untouched properties.
2. State update after save, NOT a reload from disk.
3. `inferDefaultScope` uses `existsSync` on the project path.
4. Every `enum` field has `optionLabels` with behavioral summaries and default marker.
5. `notify` on save success — the extension, not the modal, confirms.

### B.5 `src/index.ts` — extension entry point

```ts
const state: RedactSecretsState = { mode: DEFAULT_MODE, config: EMPTY_CONFIG };

export default function (pi: ExtensionAPI) {
  pi.on(EVENT_SESSION_START, async (_event: any, ctx: any) => {
    try {
      state.config = await loadRedactSecretsConfig(ctx.cwd);
      state.mode = state.config.mode;
    } catch {
      state.config = EMPTY_CONFIG;
      state.mode = DEFAULT_MODE;
      notify(ctx, "Failed to load config, using defaults", "warning");
    }
  });

  pi.registerCommand("redact-secrets:config", {
    description: "Configure pi-redact-secrets settings",
    handler: async (_args: string, ctx: any) =>
      handleConfigCommand(_args, ctx as RedactSecretsContext, ctx.cwd ?? process.cwd(), state),
  });

  pi.registerCommand(REDACT_SECRETS_COMMAND_NAME, {
    description: REDACT_SECRETS_COMMAND_DESCRIPTION,
    handler: async (args: string, ctx: any) =>
      handleRedactSecretsCommand(args, ctx as RedactSecretsContext, state),
  });

  pi.on(EVENT_INPUT, async (event: any, ctx: any) =>
    handleInput(event, ctx as RedactSecretsContext, state),
  );
}
```

**Good patterns:**

1. State initialized with safe defaults before any async work.
2. Config loaded once on session start, then consumed from memory.
3. Fail-closed on config load failure — falls back to `EMPTY_CONFIG` + `DEFAULT_MODE`.
4. Toggle command mutates state directly without opening the modal.
5. Command registration uses `:config` suffix for the settings command.

### B.6 pi-base config primitives catalog

#### `config.ts` — low-level config I/O

| Export                                       | Type                                   | Purpose                                                                                                                               |
| -------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `readConfig<T>(filename, configDir?)`        | `(string, string?) => T \| null`       | Read and parse a JSON config file. Returns `null` if missing or invalid. LRU cache with mtime validation (128 entries).               |
| `writeConfig<T>(filename, data, configDir?)` | `(string, T, string?) => boolean`      | Atomic write: `JSON.stringify(data, null, 2) + newline`. Creates parent dirs. Returns `false` in vitest without explicit `configDir`. |
| `deleteConfig(filename, configDir?)`         | `(string, string?) => void`            | Delete a config file. No-op if missing.                                                                                               |
| `loadConfig<T>(filename, defaults, opts?)`   | `(string, T, LoadConfigOptions?) => T` | Layered loader: defaults → global file → project file. Always returns a full object.                                                  |
| `deepMerge<T>(base, overrides)`              | `(T, Partial<T>) => T`                 | Recursive merge. Used internally by `loadConfig` with `merge: "deep"`.                                                                |
| `getExtensionsDir()`                         | `() => string`                         | Returns `~/.pi/agent/extensions`.                                                                                                     |
| `readBooleanEnv(name, fallback)`             | `(string, boolean) => boolean`         | Parse `1/true/yes/on` → `true`, `0/false/no/off` → `false`.                                                                           |
| `readPositiveIntEnv(name, fallback)`         | `(string, number) => number`           | Parse positive integers only. Returns fallback on non-positive or non-numeric.                                                        |

`LoadConfigOptions`:

```ts
interface LoadConfigOptions {
  cwd?: string; // project-local override directory
  merge?: "shallow" | "deep"; // merge strategy
  configDir?: string; // override global dir (for tests)
}
```

- `merge: "shallow"` (default): `{ ...defaults, ...global, ...project }` — nested objects replaced, not merged.
- `merge: "deep"`: nested objects recursively merged via `deepMerge`. Use for nested configs.
- Returns `defaults` if both files are missing. Never returns `null`.
- The `defaults` parameter is the **first** layer, not a fallback after null.

#### `config-settings.ts` — declarative config-backed settings

```ts
interface ConfigSettingItem extends SettingItem {
  configType?: "boolean" | "number" | "stringList";
}

interface ConfigSettingsOptions<T> {
  id: string;
  label: string;
  section: string;
  defaults: T;
  buildItems: (settings: T, scope: SettingsScope, cwd: string) => ConfigSettingItem[];
  persistChange?: (scope, cwd, settingId, value, helpers) => void;
}

export function registerConfigSettings<T>(options: ConfigSettingsOptions<T>): void;
```

Auto-persist handles `boolean`, `number`, and `stringList`. Enum settings require a custom `persistChange` callback.

#### `settings-registry.ts` — central settings discovery

```ts
export type SettingsScope = "project" | "global";

export interface SettingsSection {
  id: string;
  label: string;
  loadValues: (scope: SettingsScope, cwd: string) => SettingItem[];
  persistChange: (scope: SettingsScope, cwd: string, settingId: string, value: string) => void;
}

export function registerSettings(section: SettingsSection): void;
export function getRegisteredSettings(): SettingsSection[];
export function clearRegisteredSettings(): void;
```

**Current limitation:** `SettingsSection` has no `configFilename` field, so the
central settings UI cannot pass it to `openSettingsModal` for scope tabs.

#### `settings/index.ts` — modal public API

| Export                                                                  | Purpose                                                                 |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `openSettingsModal(ctx, options)`                                       | Happy-path: opens a centered overlay, resolves on close.                |
| `createSettingsModal(ctx, options)`                                     | Factory: returns a `SettingsModalFactory` for custom overlay lifecycle. |
| `createSettingsModalBody(options, ctx)`                                 | Low-level: renders the modal body component.                            |
| `createInputSubmenu(currentValue, label, done)`                         | Reusable text-input submenu with enter-to-confirm.                      |
| `RENDERERS`                                                             | Built-in field renderers map.                                           |
| All `Field` types, `SettingsModalOptions`, `Tab`, `SettingsTheme`, etc. | Type definitions.                                                       |

**Key modal behavior with `configFilename`:**

1. Loads both global and project configs at mount time.
2. Populates per-scope values for each field using `getNestedValue(obj, field.key)`.
3. Shows Global / Project Local tabs. Tab switching changes `activeTabId`, which changes the `value` getter on each row.
4. Buffered mode snapshots both global and project initial values separately. Dirty tracking is per-scope.
5. On save, `allValues(scope)` collects the active-scope value for each row and passes them to `onSave` with the chosen scope.
6. `defaults` option provides fallback values when a key is missing from both config files AND the field has no `default` property.

#### `registry.ts` — symbol-based global registries

```ts
export function createRegistry<T>(name: string): {
  register: (id: string, value: T) => void;
  unregister: (id: string, value: T) => void;
  getAll: () => T[];
  clear: () => void;
};

export function createSessionStateRegistry<TState>(name: string): {
  get: (cwd: string) => TState | undefined;
  set: (cwd: string, value: TState) => void;
  clear: (cwd: string) => void;
};
```

Both use `Symbol.for` + `globalThis` so all jiti-resolved module instances share the same Map.

---

## Appendix C: Good Patterns to Lift

These patterns from pi-redact-secrets are NOT yet in the base howto but SHOULD be canonical:

1. **`DEFAULTS` is a complete object with all properties.** Every property, even optional ones, has a default value.
2. **Domain validators as private functions inside `config.ts`.** Throwing on bad input is acceptable for security-sensitive fields; fallback-to-default for simple coercion.
3. **`parseMode` for enum validation.** Small function that normalizes and validates against a Set. Returns `undefined` on failure.
4. **String-enum env override pattern:** parse + validate before assigning. Do NOT assign raw env strings.
5. **Numeric env override with manual clamp:** `parseFloat` + `Math.min/Math.max` for bounded ranges.
6. **Separate `Config` type from `State` type.** Config is persisted. State is runtime-only.
7. **Notification messages as a constant map.** Centralize all user-facing strings.
8. **`onSave` notify on success.** The extension confirms, not the modal.

---

## Appendix D: Adaptation Checklist

When adapting a package, verify each item:

- [ ] `CONFIG_FILENAME` is a single exported constant, used by `loadConfig`, `saveConfigScoped`, and `inferDefaultScope`
- [ ] `DEFAULTS` is a single exported object with every property at its default value
- [ ] `loadConfig` makes one call to `loadSharedConfig` with `merge: "deep"`, then pipes through `validateConfig`
- [ ] `validateConfig` coerces every property with `typeof` checks and clamps numeric ranges
- [ ] `saveConfigScoped` writes the full config object — no read→merge→write
- [ ] Modal passes `configFilename`, `mode: "buffered"`, `inferDefaultScope`, `title`
- [ ] Modal `fields` use flat keys or dot-notation (dot-notation requires `configFilename`)
- [ ] Modal `onSave` validates values, calls `saveConfigScoped`, updates state directly
- [ ] Every field with a non-self-explanatory label has a `description`
- [ ] Every `enum` field has `optionLabels` mapping each option to a behavioral summary with default marker
- [ ] No underscore-separated field keys
- [ ] No double-load pattern
- [ ] No manual nested object reconstruction in `onSave` from dot-notation flat values
- [ ] Toggle command writes to global scope
- [ ] Config command opens the settings modal
- [ ] `index.ts`: state initialized with defaults, config loaded on session start, fail-closed on load error, event handlers consume `state.config`
- [ ] No duplicate `CONFIG_FILENAME` definitions
- [ ] For pickers/selectors: use `createSettingsModalBody` / `openSettingsModal` with `action` fields instead of handrolling `SelectList` + frame + hints
