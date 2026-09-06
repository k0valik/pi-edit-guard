/**
 * TDD tests for scope action confirm (reset/delete) in the settings modal.
 *
 * Ported from pi-blackhole-dev: verifies cancel-first ordering and
 * destructive-action warning text.
 */

import { describe, expect, it, vi, beforeAll } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

beforeAll(() => {
  initTheme();
});

import { createSettingsModalBody } from "./body.ts";
import type { Field } from "./types.ts";

// ─────────────────────────────────────────────────────────────────────
// Stubs
// ─────────────────────────────────────────────────────────────────────

function fakeTheme(): Theme {
  const passthrough = (_color: string, text: string): string => text;
  return {
    fg: passthrough,
    bg: passthrough,
    bold: (t: string) => t,
    italic: (t: string) => t,
    underline: (t: string) => t,
    inverse: (t: string) => t,
    strikethrough: (t: string) => t,
    getFgAnsi: () => "",
    getBgAnsi: () => "",
    getColorMode: () => "truecolor",
    getThinkingBorderColor: () => (s: string) => s,
    getBashModeBorderColor: () => (s: string) => s,
  } as unknown as Theme;
}

function fakeTui(): TUI {
  return {
    terminal: { rows: 40, columns: 100 },
    requestRender: vi.fn(),
  } as unknown as TUI;
}

function fakeCtx(): ExtensionContext {
  return {
    ui: {
      notify: vi.fn(),
    },
    modelRegistry: {
      getAvailable: () => [],
    },
  } as unknown as ExtensionContext;
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

describe("createSettingsModalBody — scope action confirm", () => {
  it("reset scope confirm has Cancel pre-selected (index 0)", () => {
    const onResetScope = vi.fn();
    const fields: Field[] = [{ key: "x", type: "boolean", label: "X", value: false }];
    const body = createSettingsModalBody(
      {
        title: "test",
        configFilename: "test-config.json",
        defaults: { x: false },
        fields,
        mode: "buffered",
        onSave: vi.fn(),
        onResetScope,
      },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );

    body.render(80);
    // With configFilename, tabs are [Global, Project Local] then action rows.
    // When only onResetScope is provided: Tab sequence is
    // Global -> Project Local -> Reset
    body.handleInput?.("\t"); // Tab to Project Local
    body.handleInput?.("\t"); // Tab to Reset action row
    body.handleInput?.("\r"); // Enter -> mounts scope action confirm for reset

    const output = body.render(80).join("\n");
    // Cancel should be the first option (pre-selected at index 0)
    expect(output).toContain("Cancel");
    // The destructive option should come after Cancel
    const cancelIdx = output.indexOf("Cancel");
    const resetGlobalIdx = output.indexOf("Reset to defaults (global)");
    expect(cancelIdx).toBeGreaterThanOrEqual(0);
    expect(resetGlobalIdx).toBeGreaterThanOrEqual(0);
    expect(cancelIdx).toBeLessThan(resetGlobalIdx);
  });

  it("delete scope confirm has Cancel pre-selected (index 0)", () => {
    const onDeleteScope = vi.fn();
    const fields: Field[] = [{ key: "x", type: "boolean", label: "X", value: false }];
    const body = createSettingsModalBody(
      {
        title: "test",
        configFilename: "test-config.json",
        defaults: { x: false },
        fields,
        mode: "buffered",
        onSave: vi.fn(),
        onDeleteScope,
      },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );

    body.render(80);
    // When only onDeleteScope is provided: Tab sequence is
    // Global -> Project Local -> Delete
    body.handleInput?.("\t"); // Tab to Project Local
    body.handleInput?.("\t"); // Tab to Delete action row
    body.handleInput?.("\r"); // Enter -> mounts scope action confirm for delete

    const output = body.render(80).join("\n");
    // Cancel should be the first option (pre-selected at index 0)
    expect(output).toContain("Cancel");
    // The destructive option should come after Cancel
    const cancelIdx = output.indexOf("Cancel");
    const deleteGlobalIdx = output.indexOf("Delete config (global)");
    const deleteProjectIdx = output.indexOf("Delete config (project-local)");
    expect(cancelIdx).toBeGreaterThanOrEqual(0);
    expect(deleteGlobalIdx).toBeGreaterThanOrEqual(0);
    expect(deleteProjectIdx).toBeGreaterThanOrEqual(0);
    expect(cancelIdx).toBeLessThan(deleteGlobalIdx);
    expect(cancelIdx).toBeLessThan(deleteProjectIdx);
  });

  it("scope action confirm shows destructive warning for reset", () => {
    const onResetScope = vi.fn();
    const fields: Field[] = [{ key: "x", type: "boolean", label: "X", value: false }];
    const body = createSettingsModalBody(
      {
        title: "test",
        configFilename: "test-config.json",
        defaults: { x: false },
        fields,
        mode: "buffered",
        onSave: vi.fn(),
        onResetScope,
      },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );

    body.render(80);
    body.handleInput?.("\t"); // Tab to Project Local
    body.handleInput?.("\t"); // Tab to Reset action row
    body.handleInput?.("\r"); // Enter -> reset confirm

    const output = body.render(80).join("\n");
    expect(output).toContain("reset your config to defaults");
  });

  it("scope action confirm shows destructive warning for delete", () => {
    const onDeleteScope = vi.fn();
    const fields: Field[] = [{ key: "x", type: "boolean", label: "X", value: false }];
    const body = createSettingsModalBody(
      {
        title: "test",
        configFilename: "test-config.json",
        defaults: { x: false },
        fields,
        mode: "buffered",
        onSave: vi.fn(),
        onDeleteScope,
      },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );

    body.render(80);
    body.handleInput?.("\t"); // Tab to Project Local
    body.handleInput?.("\t"); // Tab to Delete action row
    body.handleInput?.("\r"); // Enter -> delete confirm

    const output = body.render(80).join("\n");
    expect(output).toContain("permanently delete your config file");
  });
});
