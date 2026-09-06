# Settings Modal

`@k0valik/pi-base/settings` provides a reusable overlay modal for editing
extension configuration. Extensions define their config as a list of
`Field` rows and hand off rendering, dirty tracking, scope selection,
and persistence to the modal.

Two extensions already use it: `pi-cache` and `pi-statusline`.

---

## Quick start

```ts
import { openSettingsModal, type Field } from "@k0valik/pi-base/settings";

const openMySettings = async (ctx: ExtensionContext) => {
  const fields: Field[] = [
    { key: "enabled", type: "boolean", label: "Enabled", value: true },
    { key: "threshold", type: "number", label: "Threshold", value: 25, min: 1, max: 100 },
  ];

  await openSettingsModal(ctx, {
    title: "My Extension",
    fields,
    onChange: (key, value) => {
      // Persist immediately (immediate mode, the default)
      saveConfig({ [key]: value });
    },
  });
};
```

`openSettingsModal` returns a `Promise` that resolves when the user closes
the modal (Escape, Ctrl+C, or outer dismissal).

---

## Modes

### Immediate mode (default)

Every field change is persisted through `onChange` as soon as the user
commits it. This is the legacy behavior and requires no migration.

```ts
await openSettingsModal(ctx, {
  title: "My Extension",
  fields,
  onChange: (key, value) => {
    save(key, value);
  },
});
```

### Buffered mode

The modal holds edits in memory and persists only on explicit save.
This gives the user a commit boundary, dirty awareness, and scope
selection (global vs. project-local).

```ts
await openSettingsModal(ctx, {
  title: "My Extension",
  fields,
  mode: "buffered",
  onSave: async (values, scope) => {
    await saveScoped(values, scope, ctx.cwd);
  },
  onCancel: () => {
    // Discard — modal closes without writing.
  },
});
```

When `mode` is `"buffered"`:

- `onChange` is optional and serves only live preview. The extension
  is responsible for not persisting in buffered mode.
- Dirty detection is modal-owned. The modal diffs current values against
  the initial snapshot internally. Extensions do not track dirty state.
- Escape or Ctrl+S opens a confirm submenu (Save to Global / Save to
  Project Local / Discard / Cancel). The user must pick a scope before
  anything is written.
- A dirty ` ●` indicator appears in the frame title.
- Ctrl+S when clean notifies "Nothing to save."

---

## Field types

The `Field` discriminated union covers every built-in widget:

| Type        | Shape                                                              | Notes                                                      |
| ----------- | ------------------------------------------------------------------ | ---------------------------------------------------------- |
| `"boolean"` | `{ type: "boolean", value: boolean }`                              | Enter toggles                                              |
| `"enum"`    | `{ type: "enum", value: T, options: readonly T[] }`                | Enter cycles; long lists open a submenu                    |
| `"string"`  | `{ type: "string", value: string, placeholder?: string }`          | Enter edits inline                                         |
| `"number"`  | `{ type: "number", value: number, min?, max?, integer? }`          | Enter edits inline; validates on commit                    |
| `"secret"`  | `{ type: "secret", value: string }`                                | Masked display; inline edit                                |
| `"path"`    | `{ type: "path", value: string }`                                  | Same editor as string; kept distinct for future completion |
| `"action"`  | `{ type: "action", onActivate: (ctx) => void }`                    | Enter fires the callback                                   |
| `"model"`   | `{ type: "model", value: ModelValue, ... }`                        | Submenu with model picker + reasoning-effort axis          |
| `"custom"`  | `{ type: "custom", value: T, render, handleInput?, openSubmenu? }` | Escape hatch for arbitrary widgets                         |

Every variant extends `FieldBase`:

```ts
interface FieldBase {
  key: string;
  label: string;
  description?: string;
  tab?: string;
  disabled?: boolean;
  reorderable?: boolean;
  dim?: boolean | (() => boolean);
  requiresReload?: boolean; // buffered mode only
}
```

`requiresReload` is a per-field hint. When any dirty field has it set,
the confirm submenu shows "Some changes require `/reload` to take effect."

---

## Options

```ts
interface SettingsModalOptions<F extends Field = Field> {
  title?: string;
  fields: F[];
  tabs?: Tab[];
  initialTab?: string;
  enableSearch?: boolean;
  theme?: SettingsTheme;
  overlayOptions?: OverlayOptions | (() => OverlayOptions);

  // Immediate mode
  onChange?: <K extends F["key"]>(
    key: K,
    value: ValueOfField<F, K>,
    field: F,
  ) => void | Promise<void>;

  // Buffered mode
  mode?: "immediate" | "buffered";
  onSave?: (values: Record<string, unknown>, scope: "global" | "project") => void | Promise<void>;
  onCancel?: () => void;
  inferDefaultScope?: () => "global" | "project";

  // Reordering
  onReorder?: (info: { fieldKey: string; fromIndex: number; toIndex: number }) => void;

  // Lifecycle
  onClose?: () => void;
}
```

### Buffered-mode options

| Option              | Required       | Description                                                                                                                                                                            |
| ------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`              | no             | `"buffered"` to enable. Defaults to `"immediate"`.                                                                                                                                     |
| `onSave`            | yes (buffered) | Receives the full buffer (all field values) and the chosen scope. May be async. Called only on explicit save.                                                                          |
| `onCancel`          | no             | Called when the user selects Discard in the confirm submenu. Modal closes immediately after.                                                                                           |
| `inferDefaultScope` | no             | Called once at modal mount. Return `"project"` if a project-local config file exists, `"global"` otherwise. Used to pre-select the confirm submenu. Optional — defaults to `"global"`. |

### Lifecycle callbacks

| Callback                      | When it fires                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `onChange(key, value, field)` | After every field commit (both modes). In buffered mode, this is for live preview only — do not persist.                       |
| `onSave(values, scope)`       | After the user confirms a buffered save. Receives the full buffer and the chosen scope.                                        |
| `onCancel()`                  | After the user selects Discard in the confirm submenu.                                                                         |
| `onClose()`                   | After the modal closes for any reason (save, discard, Escape when clean, outer dismissal). Useful for fire-and-forget cleanup. |

---

## Tabs

When `tabs` is non-empty, fields without an explicit `tab` id surface on
the first tab. The tab strip is rendered above the field list. Tab
switching is via Shift+Tab / Tab.

```ts
await openSettingsModal(ctx, {
  title: "My Extension",
  tabs: [
    { id: "general", label: "General" },
    { id: "advanced", label: "Advanced" },
  ],
  initialTab: "advanced",
  fields: [
    { key: "enabled", type: "boolean", label: "Enabled", tab: "general", value: true },
    { key: "timeout", type: "number", label: "Timeout", tab: "advanced", value: 30 },
  ],
  onChange: (key, value) => {
    save(key, value);
  },
});
```

---

## Search

Set `enableSearch: true` to add a fuzzy-search bar. Typing filters the
field list in real time. Backspace deletes, Ctrl+U clears.

```ts
await openSettingsModal(ctx, {
  title: "My Extension",
  fields,
  enableSearch: true,
  onChange: (key, value) => {
    save(key, value);
  },
});
```

---

## Reordering

Mark rows with `reorderable: true` to let the user reorder them with
Alt+Up / Alt+Down. The modal swaps adjacent reorderable peers and calls
`onReorder` so the extension can mirror the change into persistent state.

```ts
const fields: Field[] = [
  { key: "a", type: "boolean", label: "A", reorderable: true, value: true },
  { key: "b", type: "boolean", label: "B", reorderable: true, value: false },
];

await openSettingsModal(ctx, {
  title: "My Extension",
  fields,
  onReorder: ({ fieldKey, fromIndex, toIndex }) => {
    // Mirror the reorder into your layout array or similar
  },
});
```

Non-reorderable neighbours block the move (no skip-and-swap), so group
reorderable rows contiguously inside a tab.

---

## Scope selection

Scope is chosen at save time, not edit time. The confirm prompt's save
buttons are the scope selector. No persistent scope dropdown in the
header.

If the user wants scope context during editing, show a non-interactive
indicator in the header — the modal itself does not do this automatically.

### Scope default inference

At modal open time, check whether a project-local config file exists for
the current `cwd`. If yes, default the confirm prompt's pre-selected
item to "Project Local." If not, default to "Global."

Provide this via `inferDefaultScope`:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";

await openSettingsModal(ctx, {
  title: "My Extension",
  fields,
  mode: "buffered",
  inferDefaultScope: () =>
    existsSync(join(ctx.cwd, ".pi", "my-config.json")) ? "project" : "global",
  onSave: async (values, scope) => {
    saveScoped(values, scope, ctx.cwd);
  },
});
```

This callback is optional. Without it, the confirm submenu defaults to
"Save to Global."

---

## Dirty tracking

In buffered mode, the modal owns dirty tracking. It diffs current field
values against the initial snapshot internally. Extensions do not track
dirty state.

- A field is dirty if its current value differs from the value at modal open.
- Dirty state clears when the user reverts a field to its original value.
- A colored ` ●` appears in the frame title when any field is dirty.
- The footer shows `ctrl+s save` when dirty, `esc close` when clean.

`onChange` in buffered mode is optional and serves only live preview.
Dirty detection does not depend on `onChange` being present.

---

## Error handling

If `onSave` throws, the modal catches the error, shows a notification
via `ctx.ui.notify`, and keeps the modal open so the user can retry or
cancel. The confirm submenu's `done()` is not called on error.

If `onChange` throws, the row value is rolled back and the error is
surfaced via notify. The modal stays open.

`onClose`, `onCancel`, and `render` errors are also caught defensively
so the modal cannot leave the terminal in a broken state.

---

## Singleton guard

`openSettingsModal` tracks whether a modal is already mounted on the
context. If a second call arrives while the first is still mounted, the
existing modal is closed before opening the new one. This prevents two
in-memory buffers racing to write.

---

## Keybindings

| Key               | Action                                         |
| ----------------- | ---------------------------------------------- |
| ↑ / ↓             | Move selection                                 |
| PageUp / PageDown | Scroll by 5                                    |
| Enter             | Commit field / Open submenu / Toggle           |
| Esc               | Close (clean) or open confirm submenu (dirty)  |
| Ctrl+S            | Open confirm submenu (buffered mode)           |
| Ctrl+C            | Same as Esc                                    |
| Tab / Shift+Tab   | Next / previous tab (when tabs are configured) |
| Alt+Up / Alt+Down | Reorder adjacent `reorderable` rows            |
| Backspace         | Delete char while editing / clear search       |
| Ctrl+U            | Clear search                                   |

---

## Extension wiring recipe

### 1. Config module

```ts
// config.ts
export const CONFIG_FILENAME = "my-extension-config.json";

export interface MyConfig {
  enabled: boolean;
  threshold: number;
}

export const DEFAULTS: MyConfig = {
  enabled: true,
  threshold: 25,
};

export function loadMyConfig(cwd?: string): MyConfig {
  const raw = readConfig<Record<string, unknown>>(CONFIG_FILENAME, cwd);
  return raw ? { ...DEFAULTS, ...raw } : { ...DEFAULTS };
}

export function saveMyConfig(config: MyConfig): boolean {
  return writeConfig(CONFIG_FILENAME, config);
}

export function saveMyConfigScoped(
  config: MyConfig,
  scope: "global" | "project",
  cwd: string,
): boolean {
  const dir = scope === "global" ? getExtensionsDir() : join(cwd, ".pi");
  return writeConfig(CONFIG_FILENAME, config, dir);
}
```

### 2. Entry point

```ts
// index.ts
import { openSettingsModal, type Field } from "@k0valik/pi-base/settings";
import { loadMyConfig, saveMyConfigScoped } from "./config.js";

const openMySettings = async (ctx: ExtensionContext) => {
  const current = loadMyConfig(ctx.cwd);
  const fields: Field[] = [
    { key: "enabled", type: "boolean", label: "Enabled", value: current.enabled },
    {
      key: "threshold",
      type: "number",
      label: "Threshold",
      value: current.threshold,
      min: 1,
      max: 100,
    },
  ];

  await openSettingsModal(ctx, {
    title: "@my-org/my-extension",
    fields,
    mode: "buffered",
    onSave: async (values, scope) => {
      await saveMyConfigScoped(values as MyConfig, scope, ctx.cwd);
    },
  });
};

pi.registerCommand("my-extension:config", {
  description: "Open settings",
  handler: async (_args, ctx) => await openMySettings(ctx),
});
```

### 3. Config-to-Field mapping

Map each config key to a `Field` row. Primitive config types map directly:

| Config type                 | Field type  | Extra keys                |
| --------------------------- | ----------- | ------------------------- |
| `boolean`                   | `"boolean"` | —                         |
| `number`                    | `"number"`  | `min`, `max`, `integer`   |
| `string`                    | `"string"`  | `placeholder`             |
| `string` with fixed options | `"enum"`    | `options: readonly [...]` |

Every field needs: `key` (matches config property name), `type`, `label`, `value`.

---

## Full-buffer write semantics

When saving to project local, write the **entire merged buffer** to
`<cwd>/.pi/<config-filename>.json`, not a delta patch. This preserves
existing project keys that the user didn't touch in the modal.

Example:

- Global has: `{ enabled: true, threshold: 25 }`
- Project has: `{ enabled: false }`
- User changes `threshold → 30` and saves to project local
- Result: `{ enabled: false, threshold: 30 }`

No merge logic needed in `saveXxxConfigScoped`. It writes the buffer
directly to the chosen directory. This is consistent with how `loadConfig`
already merges at read time.

---

## Backward compatibility

`mode` defaults to `"immediate"`. Existing extensions are unaffected.
`onSave` and `onCancel` are ignored in immediate mode.

---

## Reference

- Source: `packages/pi-base/src/settings/`
- Tests: `packages/pi-base/src/settings/buffered-mode.test.ts`
- Spec: `docs/modal-config-rework.md`
