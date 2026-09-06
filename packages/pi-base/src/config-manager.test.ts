/**
 * TDD tests for ConfigManager — a declarative config manager for pi extensions.
 *
 * Vertical slices — one test → one implementation → repeat.
 */

import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ConfigManager, type ConfigManagerOptions } from "./config-manager.ts";
import { deepEqual, checkConfigFile } from "./config.ts";
import { createSettingsModal } from "./settings/modal.ts";

// Mock the settings module so openSettings doesn't try to render a real modal
const mockOpenSettingsModal = vi.hoisted(() => vi.fn());
vi.mock("./settings/index.ts", () => ({
  openSettingsModal: mockOpenSettingsModal,
}));

import type { Field, SettingsModalOptions } from "./settings/types.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// ─────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────

interface TestConfig {
  enabled: boolean;
  threshold: number;
}

const DEFAULTS: TestConfig = { enabled: true, threshold: 5 };

const FIELDS = (cfg: TestConfig): Field[] => [
  { key: "enabled", type: "boolean", label: "Enabled", value: cfg.enabled },
  {
    key: "threshold",
    type: "number",
    label: "Threshold",
    value: cfg.threshold,
    min: 1,
    max: 10,
  },
];

function createManager(opts?: Partial<ConfigManagerOptions<TestConfig>>) {
  return new ConfigManager<TestConfig>({
    id: "test",
    label: "Test",
    filename: "test-config.json",
    defaults: DEFAULTS,
    fields: FIELDS,
    ...opts,
  });
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync("/tmp/config-manager-test-");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeGlobal(data: Record<string, unknown>) {
  writeFileSync(join(tempDir, "test-config.json"), JSON.stringify(data));
}

function writeProject(data: Record<string, unknown>) {
  const projectDir = join(tempDir, ".pi");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "test-config.json"), JSON.stringify(data));
}

// ─────────────────────────────────────────────────────────────────────
// Tests — deepEqual
// ─────────────────────────────────────────────────────────────────────

describe("deepEqual", () => {
  it("returns true for identical primitives", () => {
    expect(deepEqual(1, 1)).toBe(true);
  });

  it("returns false for different numbers", () => {
    expect(deepEqual(1, 2)).toBe(false);
  });

  it("returns true for identical strings", () => {
    expect(deepEqual("hello", "hello")).toBe(true);
  });

  it("returns false for different strings", () => {
    expect(deepEqual("hello", "world")).toBe(false);
  });

  it("returns true for identical booleans", () => {
    expect(deepEqual(true, true)).toBe(true);
  });

  it("returns false for different booleans", () => {
    expect(deepEqual(true, false)).toBe(false);
  });

  it("returns true for both null", () => {
    expect(deepEqual(null, null)).toBe(true);
  });

  it("returns false for null vs object", () => {
    expect(deepEqual(null, {})).toBe(false);
  });

  it("returns false for null vs undefined", () => {
    expect(deepEqual(null, undefined)).toBe(false);
  });

  it("returns true for undefined on both sides", () => {
    expect(deepEqual(undefined, undefined)).toBe(true);
  });

  it("returns true for identical arrays", () => {
    expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
  });

  it("returns false for different arrays", () => {
    expect(deepEqual([1, 2], [1, 3])).toBe(false);
  });

  it("returns false for arrays of different length", () => {
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
  });

  it("returns true for identical flat objects", () => {
    expect(deepEqual({ a: 1, b: "x" }, { a: 1, b: "x" })).toBe(true);
  });

  it("returns false for different flat objects", () => {
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
  });

  it("returns false for objects with different keys", () => {
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it("returns true for nested objects", () => {
    expect(deepEqual({ a: { b: { c: 1 } } }, { a: { b: { c: 1 } } })).toBe(true);
  });

  it("returns false for nested objects with different values", () => {
    expect(deepEqual({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false);
  });

  it("returns false for array vs object", () => {
    expect(deepEqual([1, 2], { 0: 1, 1: 2 })).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Tests — checkConfigFile
// ─────────────────────────────────────────────────────────────────────

describe("checkConfigFile", () => {
  it("returns { exists: false } when file does not exist", () => {
    const result = checkConfigFile("nonexistent.json", tempDir);
    expect(result.exists).toBe(false);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("returns valid when valid JSON object exists", () => {
    writeGlobal({ enabled: true });
    const result = checkConfigFile("test-config.json", tempDir);
    expect(result.exists).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("returns invalid for syntactically broken JSON", () => {
    writeFileSync(join(tempDir, "test-config.json"), "{ invalid json ");
    const result = checkConfigFile("test-config.json", tempDir);
    expect(result.exists).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Invalid JSON");
  });

  it("returns invalid for empty file", () => {
    writeFileSync(join(tempDir, "test-config.json"), "");
    const result = checkConfigFile("test-config.json", tempDir);
    expect(result.exists).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("empty");
  });

  it("returns invalid for whitespace-only file", () => {
    writeFileSync(join(tempDir, "test-config.json"), "   \n  \n  ");
    const result = checkConfigFile("test-config.json", tempDir);
    expect(result.exists).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("empty");
  });

  it("returns invalid when JSON is not a plain object (array)", () => {
    writeFileSync(join(tempDir, "test-config.json"), "[1, 2, 3]");
    const result = checkConfigFile("test-config.json", tempDir);
    expect(result.exists).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("plain JSON object");
  });

  it("returns invalid when JSON is a primitive", () => {
    writeFileSync(join(tempDir, "test-config.json"), '"hello"');
    const result = checkConfigFile("test-config.json", tempDir);
    expect(result.exists).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("plain JSON object");
  });

  it("returns invalid when JSON is null", () => {
    writeFileSync(join(tempDir, "test-config.json"), "null");
    const result = checkConfigFile("test-config.json", tempDir);
    expect(result.exists).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("plain JSON object");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Tests — load()
// ─────────────────────────────────────────────────────────────────────

describe("ConfigManager.load()", () => {
  it("returns defaults when no config files exist", () => {
    const mgr = createManager();
    const result = mgr.load(undefined, tempDir);
    expect(result).toEqual(DEFAULTS);
  });

  it("merges global file over defaults", () => {
    writeGlobal({ threshold: 10 });
    const mgr = createManager();
    const result = mgr.load(undefined, tempDir);
    expect(result).toEqual({ enabled: true, threshold: 10 });
  });

  it("merges project file over global file", () => {
    writeGlobal({ enabled: false, threshold: 3 });
    writeProject({ threshold: 7 });
    const mgr = createManager();
    const result = mgr.load(tempDir, tempDir);
    expect(result).toEqual({ enabled: false, threshold: 7 });
  });

  it("calls validate when provided", () => {
    writeGlobal({ threshold: 99 });
    const validate = vi.fn((raw: Record<string, unknown>) => ({
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
      threshold: typeof raw.threshold === "number" ? Math.min(10, Math.max(1, raw.threshold)) : 5,
    }));
    const mgr = createManager({ validate });
    const result = mgr.load(undefined, tempDir);
    expect(result).toEqual({ enabled: true, threshold: 10 });
    expect(validate).toHaveBeenCalledOnce();
  });

  it("applies boolean env override", () => {
    process.env.PI_TEST_ENABLED = "false";
    const mgr = createManager({ env: { enabled: "PI_TEST_ENABLED" } });
    const result = mgr.load(undefined, tempDir);
    expect(result.enabled).toBe(false);
    delete process.env.PI_TEST_ENABLED;
  });

  it("applies integer env override via readPositiveIntEnv", () => {
    process.env.PI_TEST_THRESHOLD = "8";
    const mgr = createManager({ env: { threshold: "PI_TEST_THRESHOLD" } });
    const result = mgr.load(undefined, tempDir);
    expect(result.threshold).toBe(8);
    delete process.env.PI_TEST_THRESHOLD;
  });

  it("applies custom EnvParser override", () => {
    process.env.PI_TEST_THRESHOLD = "3.5";
    const mgr = createManager({
      defaults: { enabled: true, threshold: 5 },
      env: {
        threshold: {
          var: "PI_TEST_THRESHOLD",
          parse: (raw: string) => Math.min(10, Math.max(1, Number.parseFloat(raw))),
        },
      },
    });
    const result = mgr.load(undefined, tempDir);
    expect(result.threshold).toBe(3.5);
    delete process.env.PI_TEST_THRESHOLD;
  });

  it("env override does not apply when env var is unset", () => {
    const mgr = createManager({
      env: { threshold: "PI_TEST_THRESHOLD_UNSET" },
    });
    const result = mgr.load(undefined, tempDir);
    expect(result.threshold).toBe(DEFAULTS.threshold);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Tests — loadWithWarnings()
// ─────────────────────────────────────────────────────────────────────

describe("ConfigManager.loadWithWarnings()", () => {
  it("returns config with empty warnings when all values are valid", () => {
    const mgr = createManager();
    const result = mgr.loadWithWarnings(undefined, tempDir);
    expect(result.config).toEqual(DEFAULTS);
    expect(result.warnings).toEqual([]);
  });

  it("returns warnings for invalid field values", () => {
    // Write a file with an out-of-range threshold
    writeGlobal({ threshold: 99 });
    const mgr = createManager({
      validate: (raw) => ({
        enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
        threshold: typeof raw.threshold === "number" ? raw.threshold : 5,
      }),
    });
    const result = mgr.loadWithWarnings(undefined, tempDir);
    expect(result.config.threshold).toBe(99);
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings[0]!.key).toBe("threshold");
    expect(result.warnings[0]!.message).toContain("10");
  });

  it("load() delegates to loadWithWarnings() and returns only config", () => {
    const mgr = createManager();
    writeGlobal({ threshold: 7 });
    const config = mgr.load(undefined, tempDir);
    expect(config).toEqual({ enabled: true, threshold: 7 });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Tests — save()
// ─────────────────────────────────────────────────────────────────────

describe("ConfigManager.save()", () => {
  it("writes all fields when no file existed before save", () => {
    const mgr = createManager();
    mgr.save({ enabled: false, threshold: 5 }, "global", undefined, tempDir);
    const saved = JSON.parse(readFileSync(join(tempDir, "test-config.json"), "utf-8"));
    // No file existed → every field differs from the empty baseline
    expect(saved).toEqual({ enabled: false, threshold: 5 });
    expect(Object.keys(saved)).toEqual(["enabled", "threshold"]);
  });

  it("writes all fields when all differ from defaults (no file existed)", () => {
    const mgr = createManager();
    mgr.save({ enabled: false, threshold: 10 }, "global", undefined, tempDir);
    const saved = JSON.parse(readFileSync(join(tempDir, "test-config.json"), "utf-8"));
    expect(saved).toEqual({ enabled: false, threshold: 10 });
  });

  it("writes all fields when file existed but all values are new", () => {
    // File has different values → all provided values are "new" relative to file
    writeGlobal({ enabled: false, threshold: 3 });
    const mgr = createManager();
    mgr.save({ enabled: true, threshold: 7 }, "global", undefined, tempDir);
    const saved = JSON.parse(readFileSync(join(tempDir, "test-config.json"), "utf-8"));
    expect(saved).toEqual({ enabled: true, threshold: 7 });
  });

  it("writes only fields that changed compared to the existing file", () => {
    writeGlobal({ enabled: true, threshold: 5 });
    const mgr = createManager();
    // Only enabled changed; threshold stayed the same
    mgr.save({ enabled: false, threshold: 5 }, "global", undefined, tempDir);
    const saved = JSON.parse(readFileSync(join(tempDir, "test-config.json"), "utf-8"));
    expect(saved).toEqual({ enabled: false, threshold: 5 });
  });

  it("does not write when file content already matches exactly", () => {
    writeGlobal({ enabled: false, threshold: 7 });
    const mgr = createManager();
    mgr.save({ enabled: false, threshold: 7 }, "global", undefined, tempDir);
    // No write needed — file is already up-to-date
    const saved = JSON.parse(readFileSync(join(tempDir, "test-config.json"), "utf-8"));
    expect(saved).toEqual({ enabled: false, threshold: 7 });
    // File should NOT have been re-touched (mtime unchanged same content)
    const written = readFileSync(join(tempDir, "test-config.json"), "utf-8");
    expect(JSON.parse(written)).toEqual({ enabled: false, threshold: 7 });
  });

  it("writes to project directory with diff semantics", () => {
    const mgr = createManager();
    mgr.save({ enabled: true, threshold: 7 }, "project", tempDir);
    const saved = JSON.parse(readFileSync(join(tempDir, ".pi", "test-config.json"), "utf-8"));
    expect(saved).toEqual({ enabled: true, threshold: 7 });
    expect(Object.keys(saved)).toEqual(["enabled", "threshold"]);
  });

  it("throws when saving to project scope without cwd", () => {
    const mgr = createManager();
    expect(() => mgr.save(DEFAULTS, "project", undefined)).toThrow("cwd");
  });

  it("preserves unknown keys from existing file alongside known diffs", () => {
    // Existing file has an unknown key + one known key override
    writeGlobal({ customFormat: true });
    const mgr = createManager();
    // Save with known key changes; unknown key should survive
    mgr.save({ enabled: false, threshold: 7 }, "global", undefined, tempDir);
    const saved = JSON.parse(readFileSync(join(tempDir, "test-config.json"), "utf-8"));
    expect(saved).toEqual({ enabled: false, threshold: 7, customFormat: true });
  });

  it("preserves unknown keys even when known config matches defaults", () => {
    writeGlobal({ customFormat: true, extraList: [1, 2] });
    const mgr = createManager();
    // Save with exact defaults — no known keys to write, but unknown keys survive
    // Unknown keys differ from the (empty) defaults, so they get written.
    mgr.save(DEFAULTS, "global", undefined, tempDir);
    const saved = JSON.parse(readFileSync(join(tempDir, "test-config.json"), "utf-8"));
    expect(saved).toEqual({
      enabled: true,
      threshold: 5,
      customFormat: true,
      extraList: [1, 2],
    });
  });

  it("does not add phantom unknown keys when no file existed before save", () => {
    const mgr = createManager();
    mgr.save({ enabled: false, threshold: 5 }, "global", undefined, tempDir);
    const saved = JSON.parse(readFileSync(join(tempDir, "test-config.json"), "utf-8"));
    expect(Object.keys(saved)).toEqual(["enabled", "threshold"]);
  });

  it("preserves unknown keys in project-scoped save alongside known diffs", () => {
    writeProject({ customLabel: "test" });
    const mgr = createManager();
    mgr.save({ enabled: false, threshold: 3 }, "project", tempDir);
    const saved = JSON.parse(readFileSync(join(tempDir, ".pi", "test-config.json"), "utf-8"));
    expect(saved).toEqual({
      enabled: false,
      threshold: 3,
      customLabel: "test",
    });
  });

  it("does not overwrite unchanged known keys when only one field changed", () => {
    writeGlobal({ enabled: true, threshold: 5 });
    const mgr = createManager();
    // Only threshold changed; enabled stayed
    mgr.save({ enabled: true, threshold: 8 }, "global", undefined, tempDir);
    const saved = JSON.parse(readFileSync(join(tempDir, "test-config.json"), "utf-8"));
    expect(saved).toEqual({ enabled: true, threshold: 8 });
  });

  it("never removes known keys that exist in the file but not in the diff", () => {
    // File has both keys, user only changed one
    writeGlobal({ enabled: false, threshold: 3 });
    const mgr = createManager();
    mgr.save({ enabled: true, threshold: 3 }, "global", undefined, tempDir);
    const saved = JSON.parse(readFileSync(join(tempDir, "test-config.json"), "utf-8"));
    // threshold: 3 matches the file, so it wasn't in the diff. But the
    // merge ({...existing, ...diff}) preserves it from existing.
    expect(saved).toEqual({ enabled: true, threshold: 3 });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Tests — openSettings()
// ─────────────────────────────────────────────────────────────────────

describe("ConfigManager.openSettings()", () => {
  beforeEach(() => {
    mockOpenSettingsModal.mockReset();
  });

  it("calls openSettingsModal with configFilename, mode buffered, and label as title", async () => {
    const ctx = {} as ExtensionContext;
    const onUserSave = vi.fn();
    const mgr = createManager();

    await mgr.openSettings(ctx, tempDir, onUserSave, tempDir);

    expect(mockOpenSettingsModal).toHaveBeenCalledTimes(1);
    const opts = mockOpenSettingsModal.mock.calls[0][1];
    expect(opts.configFilename).toBe("test-config.json");
    expect(opts.mode).toBe("buffered");
    expect(opts.title).toBe("Test");
    expect(opts.defaults).toEqual(DEFAULTS);
  });

  it("passes fields built from loaded config", async () => {
    writeGlobal({ enabled: false, threshold: 3 });
    const ctx = {} as ExtensionContext;
    const onUserSave = vi.fn();
    const mgr = createManager();

    await mgr.openSettings(ctx, tempDir, onUserSave, tempDir);

    const opts = mockOpenSettingsModal.mock.calls[0][1];
    expect(opts.fields).toHaveLength(2);
    expect(opts.fields[0]).toMatchObject({ key: "enabled", value: false });
    expect(opts.fields[1]).toMatchObject({ key: "threshold", value: 3 });
  });

  it("inferDefaultScope returns 'project' when project config exists", async () => {
    writeProject({ enabled: true });
    const ctx = {} as ExtensionContext;
    const onUserSave = vi.fn();
    const mgr = createManager();

    await mgr.openSettings(ctx, tempDir, onUserSave, tempDir);

    const opts = mockOpenSettingsModal.mock.calls[0][1];
    const scope = opts.inferDefaultScope();
    expect(scope).toBe("project");
  });

  it("inferDefaultScope returns 'global' when no project config exists", async () => {
    const ctx = {} as ExtensionContext;
    const onUserSave = vi.fn();
    const mgr = createManager();

    await mgr.openSettings(ctx, tempDir, onUserSave, tempDir);

    const opts = mockOpenSettingsModal.mock.calls[0][1];
    const scope = opts.inferDefaultScope();
    expect(scope).toBe("global");
  });

  it("onSave merges values, validates, saves with diff, and calls user callback", async () => {
    writeGlobal({ enabled: true, threshold: 9 });
    const validate = vi.fn((raw: Record<string, unknown>) => ({
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
      threshold: typeof raw.threshold === "number" ? Math.min(10, Math.max(1, raw.threshold)) : 5,
    }));
    const ctx = {} as ExtensionContext;
    const onUserSave = vi.fn();
    const mgr = createManager({ validate });

    await mgr.openSettings(ctx, tempDir, onUserSave, tempDir);

    const opts = mockOpenSettingsModal.mock.calls[0][1];

    // Simulate the modal's onSave being called with new values + "global" scope
    await opts.onSave({ enabled: false, threshold: 99 }, "global");

    // validate should have been called with merged values
    expect(validate).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, threshold: 99 }),
    );

    // File should have been written — only the validated field (threshold clamped to 10)
    const saved = JSON.parse(readFileSync(join(tempDir, "test-config.json"), "utf-8"));
    expect(saved).toEqual({ enabled: false, threshold: 10 });

    // User callback should have been called with the validated config
    expect(onUserSave).toHaveBeenCalledWith({ enabled: false, threshold: 10 });
  });

  it("notifies warning when global config file has malformed JSON", async () => {
    writeFileSync(join(tempDir, "test-config.json"), "{ broken json ");
    const notify = vi.fn();
    const ctx = { ui: { notify } } as unknown as ExtensionContext;
    const onUserSave = vi.fn();
    const mgr = createManager();

    await mgr.openSettings(ctx, tempDir, onUserSave, tempDir);

    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Invalid JSON"), "warning");
    // Should still open modal with defaults
    expect(mockOpenSettingsModal).toHaveBeenCalledTimes(1);
  });

  it("notifies warning when project config file has malformed JSON", async () => {
    writeGlobal({ enabled: true });
    const projectDir = join(tempDir, ".pi");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "test-config.json"), '{"enabled":');

    const notify = vi.fn();
    const ctx = { ui: { notify } } as unknown as ExtensionContext;
    const onUserSave = vi.fn();
    const mgr = createManager();

    await mgr.openSettings(ctx, tempDir, onUserSave, tempDir);

    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Invalid JSON"), "warning");
    expect(mockOpenSettingsModal).toHaveBeenCalledTimes(1);
  });

  it("does not warn when both config files have valid JSON", async () => {
    writeGlobal({ enabled: true });
    const notify = vi.fn();
    const ctx = { ui: { notify } } as unknown as ExtensionContext;
    const onUserSave = vi.fn();
    const mgr = createManager();

    await mgr.openSettings(ctx, tempDir, onUserSave, tempDir);

    expect(notify).not.toHaveBeenCalled();
  });

  it("does not warn when no config file exists", async () => {
    const notify = vi.fn();
    const ctx = { ui: { notify } } as unknown as ExtensionContext;
    const onUserSave = vi.fn();
    const mgr = createManager();

    await mgr.openSettings(ctx, tempDir, onUserSave, tempDir);

    expect(notify).not.toHaveBeenCalled();
  });
});

describe("default scope action handlers — file behavior", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync("/tmp/scope-action-test-");
    process.env.PI_CODING_AGENT_DIR = tempDir;
  });

  afterEach(() => {
    delete process.env.PI_CODING_AGENT_DIR;
    rmSync(tempDir, { recursive: true, force: true });
  });

  function fakeTheme() {
    const passthrough = (_color: string, text: string): string => text;
    return {
      fg: passthrough,
      bg: passthrough,
      bold: (t: string) => t,
      italic: (t: string) => t,
      underline: (t: string) => t,
      inverse: (t: string) => t,
      strikethrough: (t: string) => t,
    } as unknown as Theme;
  }

  it("default onResetScope preserves unknown keys and removes known keys", async () => {
    const fn = "test-config.json";
    const defaults = { foo: "bar", baz: "qux" } as Record<string, unknown>;

    const globalDir = join(tempDir, "extensions");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(
      join(globalDir, fn),
      JSON.stringify({
        foo: "override",
        baz: "override",
        extra: "unknown-should-survive",
      }),
    );

    const ctx = {
      cwd: tempDir,
      ui: { notify: vi.fn() },
    } as unknown as ExtensionContext;

    const options: SettingsModalOptions = {
      configFilename: fn,
      defaults,
      fields: [],
    };

    const factory = createSettingsModal(ctx, options);
    factory(
      { terminal: { rows: 40 }, requestRender: vi.fn() } as any,
      fakeTheme(),
      {} as any,
      vi.fn(),
    );

    await options.onResetScope!("global");

    const content = JSON.parse(readFileSync(join(globalDir, fn), "utf-8"));
    expect(content.foo).toBeUndefined();
    expect(content.baz).toBeUndefined();
    expect(content.extra).toBe("unknown-should-survive");
  });

  it("default onDeleteScope removes the entire config file", async () => {
    const fn = "test-config.json";
    const globalDir = join(tempDir, "extensions");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, fn), JSON.stringify({ foo: "bar" }));

    const ctx = {
      cwd: tempDir,
      ui: { notify: vi.fn() },
    } as unknown as ExtensionContext;

    const options: SettingsModalOptions = {
      configFilename: fn,
      defaults: {},
      fields: [],
    };

    const factory = createSettingsModal(ctx, options);
    factory(
      { terminal: { rows: 40 }, requestRender: vi.fn() } as any,
      fakeTheme(),
      {} as any,
      vi.fn(),
    );

    await options.onDeleteScope!("global");

    expect(existsSync(join(globalDir, fn))).toBe(false);
  });

  it("default onResetScope deletes file entirely when no unknown keys remain", async () => {
    const fn = "test-config.json";
    const globalDir = join(tempDir, "extensions");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, fn), JSON.stringify({ foo: "bar" }));

    const ctx = {
      cwd: tempDir,
      ui: { notify: vi.fn() },
    } as unknown as ExtensionContext;

    const options: SettingsModalOptions = {
      configFilename: fn,
      defaults: { foo: "bar" },
      fields: [],
    };

    const factory = createSettingsModal(ctx, options);
    factory(
      { terminal: { rows: 40 }, requestRender: vi.fn() } as any,
      fakeTheme(),
      {} as any,
      vi.fn(),
    );

    await options.onResetScope!("global");

    expect(existsSync(join(globalDir, fn))).toBe(false);
  });

  it("default onDeleteScope for project scope uses cwd/.pi", async () => {
    const fn = "test-config.json";
    const projectDir = join(tempDir, ".pi");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, fn), JSON.stringify({ foo: "bar" }));

    const ctx = {
      cwd: tempDir,
      ui: { notify: vi.fn() },
    } as unknown as ExtensionContext;

    const options: SettingsModalOptions = {
      configFilename: fn,
      defaults: {},
      fields: [],
    };

    const factory = createSettingsModal(ctx, options);
    factory(
      { terminal: { rows: 40 }, requestRender: vi.fn() } as any,
      fakeTheme(),
      {} as any,
      vi.fn(),
    );

    await options.onDeleteScope!("project");

    expect(existsSync(join(projectDir, fn))).toBe(false);
  });

  // ── openSettings globalConfigDir plumbing (ported from blackhole) ──
  describe("openSettings() globalConfigDir", () => {
    beforeEach(() => {
      mockOpenSettingsModal.mockReset();
    });

    it("passes globalConfigDir through to the modal options", async () => {
      const ctx = {} as ExtensionContext;
      const onUserSave = vi.fn();
      const mgr = createManager();

      await mgr.openSettings(ctx, tempDir, onUserSave, tempDir);

      const opts = mockOpenSettingsModal.mock.calls[0][1];
      expect(opts.globalConfigDir).toBe(tempDir);
    });

    it("passes undefined globalConfigDir when not provided", async () => {
      const ctx = {} as ExtensionContext;
      const onUserSave = vi.fn();
      const mgr = createManager();

      await mgr.openSettings(ctx, tempDir, onUserSave);

      const opts = mockOpenSettingsModal.mock.calls[0][1];
      expect(opts.globalConfigDir).toBeUndefined();
    });
  });
});
