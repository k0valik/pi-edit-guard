// Config-backed settings helper for pi extensions.
//
// Wraps registerSettings() and centralizes selected-scope loading + scoped persistence.
// Setting items can declare a `configType` ("boolean" | "number" | "stringList")
// to enable auto-generated persistChange. When all items have a configType,
// the persistChange callback can be omitted.
//
// Config files (named, one per section):
//   global:  ~/.pi/agent/extensions/<section>-config.json
//   project: <cwd>/.pi/<section>-config.json

import type { SettingItem } from "@earendil-works/pi-tui";
import { deleteConfig, getExtensionsDir, readConfig, writeConfig } from "./config.js";
import type { SettingsScope } from "./settings-registry.js";
import { registerSettings } from "./settings-registry.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type ConfigSettingType = "boolean" | "number" | "stringList";

export interface ConfigSettingItem extends SettingItem {
  configType?: ConfigSettingType;
}

export interface ConfigSettingsHelpers {
  set(key: string, value: unknown): void;
  unset(key: string): void;
}

export interface ConfigSettingsOptions<T> {
  /** Extension identifier — e.g. "bash-timeout", "context" */
  id: string;
  /** Human-readable label shown in the UI */
  label: string;
  /** Config section name — also used to derive filename: <section>-config.json */
  section: string;
  /** Default config values */
  defaults: T;
  /** Build SettingItem[] from scoped config. Called by loadValues. */
  buildItems: (settings: T, scope: SettingsScope, cwd: string) => ConfigSettingItem[];
  /**
   * Handle a settings change with scoped persistence helpers.
   * Optional when all items returned by `buildItems` declare a `configType`.
   */
  persistChange?: (
    scope: SettingsScope,
    cwd: string,
    settingId: string,
    value: string,
    helpers: ConfigSettingsHelpers,
  ) => void;
}

// ── Auto-generated persistChange ───────────────────────────────────────────

function autoPersistChange(
  settingId: string,
  value: string,
  helpers: ConfigSettingsHelpers,
  items: ConfigSettingItem[],
): void {
  const item = items.find((i) => i.id === settingId);
  if (!item?.configType) return;

  switch (item.configType) {
    case "boolean": {
      helpers.set(settingId, value === "on");
      break;
    }
    case "number": {
      const num = Number.parseInt(value, 10);
      if (Number.isFinite(num) && num > 0) {
        helpers.set(settingId, num);
      } else {
        helpers.unset(settingId);
      }
      break;
    }
    case "stringList": {
      const names = value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (names.length > 0) {
        helpers.set(settingId, names);
      } else {
        helpers.unset(settingId);
      }
      break;
    }
  }
}

function areAllItemsDeclarative(items: ConfigSettingItem[]): boolean {
  return items.length > 0 && items.every((i) => i.configType !== undefined);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function configFilename(section: string): string {
  return `${section}-config.json`;
}

function scopedDir(scope: SettingsScope, cwd: string): string {
  if (scope === "project") {
    return `${cwd}/.pi`;
  }
  return getExtensionsDir();
}

// ── Registration ───────────────────────────────────────────────────────────

/**
 * Register a config-backed settings section.
 *
 * When every item returned by `buildItems` declares a `configType`, the
 * `persistChange` callback is optional and will be auto-generated.
 */
export function registerConfigSettings<T>(options: ConfigSettingsOptions<T>): void {
  const filename = configFilename(options.section);

  registerSettings({
    id: options.id,
    label: options.label,
    loadValues: (scope, cwd) => {
      const dir = scopedDir(scope, cwd);
      const raw = readConfig<Record<string, unknown>>(filename, dir) ?? {};
      const settings = { ...options.defaults, ...raw } as T;
      return options.buildItems(settings, scope, cwd);
    },
    persistChange: (scope, cwd, settingId, value) => {
      const dir = scopedDir(scope, cwd);

      const helpers: ConfigSettingsHelpers = {
        set: (key, val) => {
          const existing = readConfig<Record<string, unknown>>(filename, dir) ?? {};
          existing[key] = val;
          writeConfig(filename, existing, dir);
        },
        unset: (key) => {
          const existing = readConfig<Record<string, unknown>>(filename, dir) ?? {};
          delete existing[key];
          if (Object.keys(existing).length === 0) {
            deleteConfig(filename, dir);
          } else {
            writeConfig(filename, existing, dir);
          }
        },
      };

      if (options.persistChange) {
        options.persistChange(scope, cwd, settingId, value, helpers);
        return;
      }

      const items = options.buildItems(options.defaults, scope, cwd);
      if (areAllItemsDeclarative(items)) {
        autoPersistChange(settingId, value, helpers, items);
      }
    },
  });
}
