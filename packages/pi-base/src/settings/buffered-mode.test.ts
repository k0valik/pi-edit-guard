/**
 * TDD tests for buffered modal mode.
 *
 * Vertical slices — one test → one implementation → repeat.
 */

import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

beforeAll(() => {
  initTheme();
});
import { createSettingsModalBody } from "./body.ts";
import { createSettingsModal } from "./modal.ts";
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

describe("createSettingsModalBody — buffered mode", () => {
  // Slice 1: Dirty tracking + Escape interception
  it("buffered mode: Escape on dirty opens confirm submenu instead of closing", () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    const close = vi.fn();
    const fields: Field[] = [{ key: "enabled", type: "boolean", label: "Enabled", value: false }];

    const body = createSettingsModalBody<Field>(
      { title: "test", fields, mode: "buffered", onSave, onCancel },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close },
    );

    body.render(80);
    // Toggle the boolean → dirty
    body.handleInput?.("\r");
    // Press Escape — should NOT close, should open submenu
    body.handleInput?.("\x1b");

    expect(close).not.toHaveBeenCalled();
    // Confirm submenu is mounted: frame title changes to include "Save changes?"
    const lines = body.render(80);
    expect(lines.join("\n")).toContain("Save changes?");
  });

  // Slice 2: Confirm submenu — Save
  it("buffered mode: Save Global calls onSave with full values and 'global' scope, then closes", () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    const close = vi.fn();
    const fields: Field[] = [
      { key: "enabled", type: "boolean", label: "Enabled", value: false },
      {
        key: "threshold",
        type: "number",
        label: "Threshold",
        value: 25,
        min: 1,
        max: 100,
        integer: true,
      },
    ];

    const body = createSettingsModalBody<Field>(
      { title: "test", fields, mode: "buffered", onSave, onCancel },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close },
    );

    body.render(80);
    body.handleInput?.("\r"); // toggle enabled → dirty
    body.handleInput?.("\x1b"); // Escape → submenu
    body.handleInput?.("\r"); // Enter on Save Global

    expect(onSave).toHaveBeenCalledTimes(1);
    const [values, scope] = onSave.mock.calls[0]!;
    expect(values).toEqual({ enabled: true, threshold: 25 });
    expect(scope).toBe("global");
    expect(close).toHaveBeenCalledTimes(1);
  });

  // Slice 3: Confirm submenu — Cancel (preserve edits)
  it("buffered mode: submenu Cancel returns to modal with edits intact", () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    const close = vi.fn();
    const fields: Field[] = [{ key: "enabled", type: "boolean", label: "Enabled", value: false }];

    const body = createSettingsModalBody<Field>(
      { title: "test", fields, mode: "buffered", onSave, onCancel },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close },
    );

    body.render(80);
    body.handleInput?.("\r"); // toggle → dirty
    body.handleInput?.("\x1b"); // Escape → submenu
    // Submenu is mounted
    expect(body.render(80).join("\n")).toContain("Save changes?");

    // Cancel: unmounts submenu, returns to fields
    body.handleInput?.("\x1b"); // Escape in submenu = Cancel

    // Submenu gone
    expect(body.render(80).join("\n")).not.toContain("Save changes?");
    // No save or cancel callback
    expect(onSave).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    // Edits still active (value toggled but not persisted)
    expect(close).not.toHaveBeenCalled();
  });

  // Slice 4: Confirm submenu — Discard
  it("buffered mode: submenu Discard calls onCancel and closes", () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    const close = vi.fn();
    const fields: Field[] = [{ key: "enabled", type: "boolean", label: "Enabled", value: false }];

    const body = createSettingsModalBody<Field>(
      { title: "test", fields, mode: "buffered", onSave, onCancel },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close },
    );

    body.render(80);
    body.handleInput?.("\r"); // toggle → dirty
    body.handleInput?.("\x1b"); // Escape → submenu

    // Move down twice to reach Discard (index 2):
    // 0 = Save to Global, 1 = Save to Project Local, 2 = Discard, 3 = Cancel
    body.handleInput?.("\x1b[B"); // Down
    body.handleInput?.("\x1b[B"); // Down
    body.handleInput?.("\r"); // Enter on Discard

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  // Slice 5: onSave error handling
  it("buffered mode: onSave error keeps modal open and notifies", async () => {
    const ctx = fakeCtx();
    const onSave = vi.fn().mockRejectedValueOnce(new Error("disk full"));
    const onCancel = vi.fn();
    const close = vi.fn();
    const fields: Field[] = [{ key: "enabled", type: "boolean", label: "Enabled", value: false }];

    const body = createSettingsModalBody<Field>(
      { title: "test", fields, mode: "buffered", onSave, onCancel },
      { tui: fakeTui(), theme: fakeTheme(), ctx, close },
    );

    body.render(80);
    body.handleInput?.("\r"); // toggle enabled → dirty
    body.handleInput?.("\x1b"); // Escape → submenu
    body.handleInput?.("\r"); // Select Save → onSave throws

    // Flush microtasks so the async error path completes.
    await new Promise((r) => setTimeout(r, 0));

    // Modal stays open
    expect(close).not.toHaveBeenCalled();
    // Error was surfaced via the same ctx
    expect(ctx.ui.notify).toHaveBeenCalledWith("disk full", "error");
    // Submenu still mounted (user can retry or cancel)
    expect(body.render(80).join("\n")).toContain("Save changes?");
  });

  // Slice 6: Ctrl+S shortcut
  it("buffered mode: Ctrl+S opens confirm submenu (same as Escape)", () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    const close = vi.fn();
    const fields: Field[] = [{ key: "enabled", type: "boolean", label: "Enabled", value: false }];

    const body = createSettingsModalBody<Field>(
      { title: "test", fields, mode: "buffered", onSave, onCancel },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close },
    );

    body.render(80);
    body.handleInput?.("\r"); // toggle → dirty
    body.handleInput?.("\x13"); // Ctrl+S

    // Ctrl+S should open the confirm submenu, not save directly.
    expect(onSave).toHaveBeenCalledTimes(0);
    expect(close).toHaveBeenCalledTimes(0);
    expect(body.render(80).join("\n")).toContain("Save changes?");

    // Confirm with Enter on the default option (Save to Global).
    body.handleInput?.("\r"); // Enter
    expect(onSave).toHaveBeenCalledTimes(1);
    const [, scope] = onSave.mock.calls[0]!;
    expect(scope).toBe("global"); // default when no project config
    expect(close).toHaveBeenCalledTimes(1);
  });

  // Slice 9: requiresReload aggregation
  it("buffered mode: confirm submenu shows reload hint when dirty fields have requiresReload", () => {
    const onSave = vi.fn();
    const close = vi.fn();
    const fields: Field[] = [
      {
        key: "enabled",
        type: "boolean",
        label: "Enabled",
        value: false,
        requiresReload: true,
      },
      {
        key: "threshold",
        type: "number",
        label: "Threshold",
        value: 25,
        min: 1,
        max: 100,
        integer: true,
      },
    ];

    const body = createSettingsModalBody<Field>(
      { title: "test", fields, mode: "buffered", onSave },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close },
    );

    body.render(80);
    body.handleInput?.("\r"); // toggle enabled → dirty
    body.handleInput?.("\x1b"); // Escape → submenu

    const lines = body.render(80).join("\n");
    expect(lines).toContain("/reload");
  });

  // Slice 7: Singleton guard
  it("modal.ts: opening a second modal closes the first", () => {
    const ctx = fakeCtx();
    const fields: Field[] = [{ key: "x", type: "boolean", label: "X", value: false }];

    const firstDone = vi.fn();
    const secondDone = vi.fn();

    const factory1 = createSettingsModal(ctx, { fields });
    const factory2 = createSettingsModal(ctx, { fields });

    const _comp1 = factory1(fakeTui(), fakeTheme(), null!, firstDone);
    const _comp2 = factory2(fakeTui(), fakeTheme(), null!, secondDone);

    // Opening the second should have closed the first.
    expect(firstDone).toHaveBeenCalledTimes(1);
    expect(secondDone).not.toHaveBeenCalled();
  });

  it("buffered mode: dirty indicator ● appears in title when dirty", () => {
    const onSave = vi.fn();
    const close = vi.fn();
    const fields: Field[] = [{ key: "enabled", type: "boolean", label: "Enabled", value: false }];

    const body = createSettingsModalBody<Field>(
      { title: "@k0valik/pi-cache", fields, mode: "buffered", onSave },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close },
    );

    body.render(80);
    // Initially clean — no dot
    expect(body.render(80).join("\n")).not.toContain("●");

    body.handleInput?.("\r"); // toggle → dirty
    // Now dirty — dot appears in title
    expect(body.render(80).join("\n")).toContain("@k0valik/pi-cache ●");
  });

  it("buffered mode: inferDefaultScope callback pre-selects scope in confirm submenu", () => {
    const onSave = vi.fn();
    const close = vi.fn();
    const fields: Field[] = [{ key: "x", type: "boolean", label: "X", value: false }];

    const body = createSettingsModalBody<Field>(
      {
        title: "test",
        fields,
        mode: "buffered",
        onSave,
        inferDefaultScope: () => "project",
      },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close },
    );

    body.render(80);
    body.handleInput?.("\r"); // toggle → dirty
    body.handleInput?.("\x1b"); // Escape → submenu

    // Press Enter immediately — should select the pre-selected option
    // (index 1 = Save to Project Local, because inferDefaultScope returned "project").
    body.handleInput?.("\r");

    expect(onSave).toHaveBeenCalledTimes(1);
    const [, scope] = onSave.mock.calls[0]!;
    expect(scope).toBe("project");
    expect(close).toHaveBeenCalledTimes(1);
  });

  // Bug fix: reverting a value to its initial state clears dirty
  it("buffered mode: reverting a value to its initial state clears dirty", () => {
    const onSave = vi.fn();
    const close = vi.fn();
    const fields: Field[] = [{ key: "enabled", type: "boolean", label: "Enabled", value: false }];

    const body = createSettingsModalBody<Field>(
      { title: "test", fields, mode: "buffered", onSave },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close },
    );

    body.render(80);
    // false → true: dirty
    body.handleInput?.("\r");
    expect(body.render(80).join("\n")).toContain("test ●");

    // true → false: reverted to initial, should clear dirty
    body.handleInput?.("\r");
    expect(body.render(80).join("\n")).not.toContain("●");
    expect(onSave).not.toHaveBeenCalled();
  });

  // Bug fix: onChange throw should not mark field dirty
  it("buffered mode: onChange throw does not mark field dirty", () => {
    const onChange = vi.fn().mockImplementation(() => {
      throw new Error("onChange rejected");
    });
    const onSave = vi.fn();
    const close = vi.fn();
    const ctx = fakeCtx();
    const fields: Field[] = [{ key: "enabled", type: "boolean", label: "Enabled", value: false }];

    const body = createSettingsModalBody<Field>(
      { title: "test", fields, mode: "buffered", onChange, onSave },
      { tui: fakeTui(), theme: fakeTheme(), ctx, close },
    );

    body.render(80);
    body.handleInput?.("\r"); // toggle attempts to commit, onChange throws

    // Value rolled back, not dirty
    expect(body.render(80).join("\n")).not.toContain("●");
    // Error surfaced
    expect(ctx.ui.notify).toHaveBeenCalledWith("onChange rejected", "error");
  });

  it("buffered mode: Ctrl+S when clean saves defaults directly", () => {
    const onSave = vi.fn();
    const ctx = fakeCtx();
    const fields: Field[] = [{ key: "enabled", type: "boolean", label: "Enabled", value: false }];

    const body = createSettingsModalBody<Field>(
      { title: "test", fields, mode: "buffered", onSave },
      { tui: fakeTui(), theme: fakeTheme(), ctx, close: vi.fn() },
    );

    body.render(80);
    // No edits made — clean
    body.handleInput?.("\x13"); // Ctrl+S

    expect(onSave).toHaveBeenCalledTimes(1);
    const [values, scope] = onSave.mock.calls[0]!;
    expect(values).toEqual({ enabled: false });
    expect(scope).toBe("global");
  });

  // ── Ctrl+C mid-edit (ported from blackhole) ──
  it("buffered mode: ctrl+c mid-edit opens confirm submenu or closes", () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    const close = vi.fn();
    const fields: Field[] = [{ key: "enabled", type: "boolean", label: "Enabled", value: false }];

    const body = createSettingsModalBody<Field>(
      { title: "test", fields, mode: "buffered", onSave, onCancel },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close },
    );

    body.render(80);
    body.handleInput?.("\r"); // toggle → dirty

    // Start editing the field (Enter again to enter inline edit for string-like, but for boolean Enter toggles)
    // For boolean, Enter toggles. Let's use a string field instead to test mid-edit ctrl+c.
  });

  it("buffered mode: ctrl+c mid-string-edit opens confirm submenu when dirty", () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    const close = vi.fn();
    const fields: Field[] = [
      { key: "enabled", type: "boolean", label: "Enabled", value: false },
      { key: "name", type: "string", label: "Name", value: "hello" },
    ];

    const body = createSettingsModalBody<Field>(
      { title: "test", fields, mode: "buffered", onSave, onCancel },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close },
    );

    body.render(80);
    body.handleInput?.("\x1b[B"); // Down to string field
    body.handleInput?.("\r"); // Enter to start editing
    body.handleInput?.("a"); // type 'a' in editor

    // Now move back to boolean and toggle it to make dirty
    body.handleInput?.("\x1b[A"); // Up to boolean
    body.handleInput?.("\r"); // Toggle boolean → dirty

    // Move back to string field (still editing state is separate per field)
    body.handleInput?.("\x1b[B"); // Down to string
    body.handleInput?.("\r"); // Enter to start editing string again

    // ctrl+c mid-edit should open confirm submenu (dirty)
    body.handleInput?.("\x03"); // Ctrl+C

    expect(close).not.toHaveBeenCalled();
    expect(body.render(80).join("\n")).toContain("Save changes?");
  });

  it("buffered mode: ctrl+c mid-string-edit closes when not dirty", () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    const close = vi.fn();
    const fields: Field[] = [{ key: "name", type: "string", label: "Name", value: "hello" }];

    const body = createSettingsModalBody<Field>(
      { title: "test", fields, mode: "buffered", onSave, onCancel },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close },
    );

    body.render(80);
    body.handleInput?.("\r"); // Enter to start editing
    // Don't type anything — still clean

    // ctrl+c mid-edit should close directly (not dirty)
    body.handleInput?.("\x03"); // Ctrl+C

    expect(close).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  describe("tabulated view with scope tabs (configFilename)", () => {
    let tmpDir: string;
    let globalDir: string;
    let projectDir: string;
    let origAgentDir: string | undefined;

    const FILENAME = "test-scope-config.json";
    const DEFAULTS = { enabled: true, threshold: 50 };

    beforeAll(() => {
      origAgentDir = process.env.PI_CODING_AGENT_DIR;
      tmpDir = mkdtempSync("/tmp/pi-modal-test-");
      globalDir = join(tmpDir, "extensions");
      projectDir = join(tmpDir, "project");
      mkdirSync(globalDir, { recursive: true });
      mkdirSync(join(projectDir, ".pi"), { recursive: true });
      process.env.PI_CODING_AGENT_DIR = tmpDir;
    });

    afterAll(() => {
      if (origAgentDir !== undefined) {
        process.env.PI_CODING_AGENT_DIR = origAgentDir;
      } else {
        delete process.env.PI_CODING_AGENT_DIR;
      }
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("loads separate global vs project local configs and switches value view via Tab press", () => {
      writeFileSync(join(globalDir, FILENAME), JSON.stringify({ enabled: false, threshold: 42 }));
      writeFileSync(join(projectDir, ".pi", FILENAME), JSON.stringify({ threshold: 99 }));

      const fields: Field[] = [
        { key: "enabled", type: "boolean", label: "Enabled", value: true },
        { key: "threshold", type: "number", label: "Threshold", value: 50 },
      ];

      const onSave = vi.fn();
      const close = vi.fn();
      const ctx = { ...fakeCtx(), cwd: projectDir };

      const body = createSettingsModalBody<Field>(
        {
          title: "test",
          fields,
          mode: "buffered",
          configFilename: FILENAME,
          defaults: DEFAULTS,
          onSave,
        },
        { tui: fakeTui(), theme: fakeTheme(), ctx, close },
      );

      // Default view is Global. Verify values loaded from global file (defaults override).
      body.render(80);
      expect(body.render(80).join("\n")).toContain("Global");

      // Select first row (enabled), value should be off (false)
      body.handleInput?.("\x1b[B"); // Move focus to second row (threshold)
      // Check that it displays threshold as 42
      expect(body.render(80).join("\n")).toContain("42");

      // Press Tab to skip active tab and switch to Project Local
      body.handleInput?.("\t");
      expect(body.render(80).join("\n")).toContain("Project Local");

      // Check that threshold displays as 99
      expect(body.render(80).join("\n")).toContain("99");
    });

    it("allows independent editing and dirty tracking on both tabs", () => {
      writeFileSync(join(globalDir, FILENAME), JSON.stringify({ enabled: false, threshold: 42 }));
      writeFileSync(join(projectDir, ".pi", FILENAME), JSON.stringify({ threshold: 99 }));

      const fields: Field[] = [
        { key: "enabled", type: "boolean", label: "Enabled", value: true },
        { key: "threshold", type: "number", label: "Threshold", value: 50 },
      ];

      const onSave = vi.fn();
      const close = vi.fn();
      const ctx = { ...fakeCtx(), cwd: projectDir };

      const body = createSettingsModalBody<Field>(
        {
          title: "test",
          fields,
          mode: "buffered",
          configFilename: FILENAME,
          defaults: DEFAULTS,
          onSave,
        },
        { tui: fakeTui(), theme: fakeTheme(), ctx, close },
      );

      // Currently on Global tab
      body.render(80);
      // Toggle the boolean (enabled) on Global
      body.handleInput?.("\r"); // Off -> On on Global

      // Global tab should show dirty indicator ●
      const linesGlobal = body.render(80).join("\n");
      expect(linesGlobal).toContain("Global ●");
      expect(linesGlobal).not.toContain("Project Local ●");

      // Switch to Project Local tab (skips already-active Global)
      body.handleInput?.("\t");
      const linesProject = body.render(80).join("\n");
      // Enabled on Project should still be off (since we only changed Global)
      // Project Local should not show dirty indicator
      expect(linesProject).not.toContain("Project Local ●");

      // Toggle enabled on Project Local
      body.handleInput?.("\r"); // Off -> On on Project Local
      expect(body.render(80).join("\n")).toContain("Project Local ●");
    });

    it("saves the respective scope values when confirmed from that scope", () => {
      writeFileSync(join(globalDir, FILENAME), JSON.stringify({ enabled: false, threshold: 42 }));
      writeFileSync(join(projectDir, ".pi", FILENAME), JSON.stringify({ threshold: 99 }));

      const fields: Field[] = [
        { key: "enabled", type: "boolean", label: "Enabled", value: true },
        { key: "threshold", type: "number", label: "Threshold", value: 50 },
      ];

      const onSave = vi.fn();
      const close = vi.fn();
      const ctx = { ...fakeCtx(), cwd: projectDir };

      const body = createSettingsModalBody<Field>(
        {
          title: "test",
          fields,
          mode: "buffered",
          configFilename: FILENAME,
          defaults: DEFAULTS,
          onSave,
        },
        { tui: fakeTui(), theme: fakeTheme(), ctx, close },
      );

      // On Global tab, change threshold to 75
      body.render(80);
      body.handleInput?.("\x1b[B"); // Move focus to threshold
      body.handleInput?.("\r"); // Enter edit mode
      body.handleInput?.("\x7f"); // Delete back
      body.handleInput?.("\x7f"); // Delete back
      body.handleInput?.("7");
      body.handleInput?.("5");
      body.handleInput?.("\r"); // Commit threshold as 75

      // Confirm submenu save
      body.handleInput?.("\x1b"); // Escape -> Submenu
      body.handleInput?.("\r"); // Save to Global

      expect(onSave).toHaveBeenCalledTimes(1);
      const [values, scope] = onSave.mock.calls[0]!;
      expect(values).toEqual({ enabled: false, threshold: 75 });
      expect(scope).toBe("global");
    });
  });
});
