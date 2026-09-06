/**
 * `createSettingsModal` and `openSettingsModal` — the public modal
 * entry points. Both wrap `createSettingsModalBody` and shape it for
 * `ctx.ui.custom`.
 */

import { join } from "node:path";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, KeybindingsManager, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { createSettingsModalBody } from "./body";
import { getExtensionsDir, readConfig, writeConfig, deleteConfig } from "../config.ts";
import type { Field, SettingsModalFactory, SettingsModalOptions } from "./types";

const DEFAULT_OVERLAY: OverlayOptions = {
  anchor: "center",
  width: "92%",
  maxHeight: "95%",
};

// Singleton guard: track one open modal per ExtensionContext.
// WeakMap so entries are GC'd when the context is no longer referenced.
const openModals = new WeakMap<ExtensionContext, (result: void) => void>();

/**
 * Build a `ctx.ui.custom`-compatible factory for the settings modal.
 * Useful for callers that already manage their own overlay lifecycle.
 *
 * The returned factory captures `ctx` from `openSettingsModal`'s call
 * site — when used standalone, the caller is expected to invoke it via
 * `ctx.ui.custom(createSettingsModal(opts), …)`, and pi will pass the
 * tui/theme/keybindings/done arguments at mount time.
 */
export function createSettingsModal<F extends Field>(
  ctx: ExtensionContext,
  options: SettingsModalOptions<F>,
): SettingsModalFactory<void> {
  return (
    tui: TUI,
    theme: Theme,
    _keybindings: KeybindingsManager,
    done: (result: void) => void,
  ): Component => {
    const close = (): void => {
      try {
        options.onClose?.();
      } catch {
        // Caller-supplied onClose must not break the modal teardown.
      }
      openModals.delete(ctx);
      done();
    };

    // Singleton guard: if a modal is already open on this ctx, close
    // it before opening the new one. This prevents two in-memory
    // buffers racing to write.
    const existing = openModals.get(ctx);
    if (existing) {
      try {
        existing(void 0);
      } catch {
        // Defensive: existing modal's close must not break the new one.
      }
    }
    openModals.set(ctx, close);

    // Auto-inject default scope action handlers when configFilename is
    // set but the callbacks are absent. This ensures that any modal using
    // scope tabs always has reset/delete actions without requiring every
    // caller to supply them explicitly.
    if (options.configFilename) {
      if (!options.onResetScope) {
        options.onResetScope = async (scope: "global" | "project") => {
          const dir =
            scope === "project"
              ? join(ctx.cwd, ".pi")
              : (options.globalConfigDir ?? getExtensionsDir());
          const knownKeys = new Set(Object.keys(options.defaults ?? {}));
          const existing = readConfig<Record<string, unknown>>(options.configFilename!, dir);
          const unknownKeys: Record<string, unknown> = {};
          if (existing && typeof existing === "object") {
            for (const [key, val] of Object.entries(existing)) {
              if (!knownKeys.has(key)) unknownKeys[key] = val;
            }
          }
          if (Object.keys(unknownKeys).length > 0) {
            writeConfig(options.configFilename!, unknownKeys, dir);
          } else {
            deleteConfig(options.configFilename!, dir);
          }
        };
      }
      if (!options.onDeleteScope) {
        options.onDeleteScope = async (scope: "global" | "project") => {
          const dir =
            scope === "project"
              ? join(ctx.cwd, ".pi")
              : (options.globalConfigDir ?? getExtensionsDir());
          deleteConfig(options.configFilename!, dir);
        };
      }
    }

    return createSettingsModalBody<F>(options, { tui, theme, ctx, close });
  };
}

/**
 * Convenience: open a settings modal as a centered overlay and resolve
 * when the user closes it. This is the **happy-path** entry point most
 * callers want.
 *
 * Defaults: anchor center, width 92%, maxHeight 95%. Override via
 * `options.overlayOptions`.
 *
 * @example
 * ```ts
 * await openSettingsModal(ctx, {
 *   title: "@k0valik/pi-voice",
 *   fields: [
 *     { key: "muted", type: "boolean", label: "Muted", value: cfg.muted },
 *   ],
 *   onChange: (key, value) => { cfg[key] = value; saveConfig(cfg); },
 * });
 * ```
 */
export async function openSettingsModal<F extends Field>(
  ctx: ExtensionContext,
  options: SettingsModalOptions<F>,
): Promise<void> {
  const overlayOptions = options.overlayOptions ?? DEFAULT_OVERLAY;
  await ctx.ui.custom<void>(createSettingsModal(ctx, options), {
    overlay: true,
    overlayOptions,
  });
}
