/**
 * ConfigManager integration for the edit-guard extension.
 *
 * Declarative config: defaults, fields, env overrides. ConfigManager owns
 * loading, saving, modal wiring, and scope tabs.
 */

import { ConfigManager } from "../../packages/pi-base/src/config-manager.js";
import { readEnv } from "./env.js";
import { MAX_LIMIT_BYTES, MIN_MAX_BYTES, clampMaxBytes } from "../history/store.js";

export const CONFIG_FILENAME = "edit-guard-config.json";

export interface EditGuardConfig {
  repairPolicy: "conservative" | "adaptive" | "recover";
  repairEnabled: boolean;
  staleReadEnabled: boolean;
  staleReadToleranceMs: number;
  stormbreakerEnabled: boolean;
  stormbreakerThreshold: number;
  /** Auto-resume with a corrective retry prompt after a loop break. */
  stormbreakerAutoContinue: boolean;
  /** Pause length before the automatic retry turn fires (clamped 1000-10000). */
  stormbreakerRetryDelayMs: number;
  preflightEnabled: boolean;
  editOverrideEnabled: boolean;
  telemetryEnabled: boolean;
  undoEnabled: boolean;
  /** Byte budget for the JSONL undo dump store; oldest records evicted (FIFO) beyond it. */
  undoMaxBytes: number;
  overwriteGuardEnabled: boolean;
  /** Toggle all edit-tool UI warnings (coherence, corruption, partial apply, repair notes, etc.). */
  warningsEnabled: boolean;
  coherenceCheckEnabled: boolean;
  /** Emit a one-line advisory when a tool accesses a path outside cwd. */
  outsideCwdAdvisoryEnabled: boolean;
}

const envDefaults = readEnv();

export const DEFAULTS: EditGuardConfig = {
  repairPolicy: envDefaults.repairPolicy,
  repairEnabled: envDefaults.repairEnabled,
  staleReadEnabled: envDefaults.staleReadEnabled,
  staleReadToleranceMs: envDefaults.staleReadToleranceMs,
  stormbreakerEnabled: envDefaults.stormbreakerEnabled,
  stormbreakerThreshold: envDefaults.stormbreakerThreshold,
  stormbreakerAutoContinue: envDefaults.stormbreakerAutoContinue,
  stormbreakerRetryDelayMs: envDefaults.stormbreakerRetryDelayMs,
  preflightEnabled: envDefaults.preflightEnabled,
  editOverrideEnabled: envDefaults.editOverrideEnabled,
  telemetryEnabled: envDefaults.telemetryEnabled,
  undoEnabled: envDefaults.undoEnabled,
  undoMaxBytes: envDefaults.undoMaxBytes,
  overwriteGuardEnabled: envDefaults.overwriteGuardEnabled,
  warningsEnabled: envDefaults.warningsEnabled,
  coherenceCheckEnabled: envDefaults.coherenceCheckEnabled,
  outsideCwdAdvisoryEnabled: envDefaults.outsideCwdAdvisoryEnabled,
};

/**
 * Singleton ConfigManager instance. Call `config.load(cwd)` to resolve
 * layered config (defaults ← global ← project ← env).
 */
export const config = new ConfigManager<EditGuardConfig>({
  id: "edit-guard",
  label: "Edit Guard",
  filename: CONFIG_FILENAME,
  defaults: DEFAULTS,
  validate: (raw): EditGuardConfig => ({
    repairPolicy:
      typeof raw.repairPolicy === "string"
        ? (["conservative", "adaptive", "recover"] as readonly string[]).includes(raw.repairPolicy)
          ? (raw.repairPolicy as EditGuardConfig["repairPolicy"])
          : DEFAULTS.repairPolicy
        : DEFAULTS.repairPolicy,
    repairEnabled:
      typeof raw.repairEnabled === "boolean" ? raw.repairEnabled : DEFAULTS.repairEnabled,
    staleReadEnabled:
      typeof raw.staleReadEnabled === "boolean" ? raw.staleReadEnabled : DEFAULTS.staleReadEnabled,
    staleReadToleranceMs:
      typeof raw.staleReadToleranceMs === "number" && Number.isFinite(raw.staleReadToleranceMs)
        ? Math.max(0, raw.staleReadToleranceMs)
        : DEFAULTS.staleReadToleranceMs,
    stormbreakerEnabled:
      typeof raw.stormbreakerEnabled === "boolean"
        ? raw.stormbreakerEnabled
        : DEFAULTS.stormbreakerEnabled,
    stormbreakerThreshold:
      typeof raw.stormbreakerThreshold === "number" && Number.isFinite(raw.stormbreakerThreshold)
        ? Math.min(10, Math.max(1, raw.stormbreakerThreshold))
        : DEFAULTS.stormbreakerThreshold,
    stormbreakerAutoContinue:
      typeof raw.stormbreakerAutoContinue === "boolean"
        ? raw.stormbreakerAutoContinue
        : DEFAULTS.stormbreakerAutoContinue,
    stormbreakerRetryDelayMs:
      typeof raw.stormbreakerRetryDelayMs === "number" &&
      Number.isFinite(raw.stormbreakerRetryDelayMs)
        ? Math.min(10000, Math.max(1000, raw.stormbreakerRetryDelayMs))
        : DEFAULTS.stormbreakerRetryDelayMs,
    preflightEnabled:
      typeof raw.preflightEnabled === "boolean" ? raw.preflightEnabled : DEFAULTS.preflightEnabled,
    editOverrideEnabled:
      typeof raw.editOverrideEnabled === "boolean"
        ? raw.editOverrideEnabled
        : DEFAULTS.editOverrideEnabled,
    telemetryEnabled:
      typeof raw.telemetryEnabled === "boolean" ? raw.telemetryEnabled : DEFAULTS.telemetryEnabled,
    undoEnabled: typeof raw.undoEnabled === "boolean" ? raw.undoEnabled : DEFAULTS.undoEnabled,
    undoMaxBytes:
      typeof raw.undoMaxBytes === "number" && Number.isFinite(raw.undoMaxBytes)
        ? clampMaxBytes(raw.undoMaxBytes)
        : DEFAULTS.undoMaxBytes,
    overwriteGuardEnabled:
      typeof raw.overwriteGuardEnabled === "boolean"
        ? raw.overwriteGuardEnabled
        : DEFAULTS.overwriteGuardEnabled,
    warningsEnabled:
      typeof raw.warningsEnabled === "boolean" ? raw.warningsEnabled : DEFAULTS.warningsEnabled,
    coherenceCheckEnabled:
      typeof raw.coherenceCheckEnabled === "boolean"
        ? raw.coherenceCheckEnabled
        : DEFAULTS.coherenceCheckEnabled,
    outsideCwdAdvisoryEnabled:
      typeof raw.outsideCwdAdvisoryEnabled === "boolean"
        ? raw.outsideCwdAdvisoryEnabled
        : DEFAULTS.outsideCwdAdvisoryEnabled,
  }),
  fields: (cfg) => [
    {
      key: "overwriteGuardEnabled",
      label: "Overwrite Guard",
      type: "boolean",
      description:
        "Block `write` calls that would overwrite an existing non-empty file. A second `write` to the same file in the same session is always allowed.",
      value: cfg.overwriteGuardEnabled,
      default: DEFAULTS.overwriteGuardEnabled,
      valueDescriptions: {
        on: "Active — blocks first overwrite per file per session",
        off: "Suspended — allows all writes",
      },
    },
    {
      key: "warningsEnabled",
      label: "Edit Warnings",
      type: "boolean",
      description:
        "Show edit-tool warnings in the TUI (corruption, partial apply, repair notes, etc.).",
      value: cfg.warningsEnabled,
      default: DEFAULTS.warningsEnabled,
      valueDescriptions: {
        on: "Active — shows warnings in TUI",
        off: "Suspended — suppresses TUI warnings",
      },
    },
    {
      key: "coherenceCheckEnabled",
      label: "Coherence Check",
      type: "boolean",
      description:
        "Run the post-edit coherence checker (indentation jumps, brace balance). When disabled, the checker is skipped entirely.",
      value: cfg.coherenceCheckEnabled,
      default: DEFAULTS.coherenceCheckEnabled,
      valueDescriptions: {
        on: "Active — runs after edits",
        off: "Suspended — skipped by default",
      },
    },
    {
      key: "repairEnabled",
      label: "Repair Pipeline",
      type: "boolean",
      description: "Enable the repair pipeline for edit tool arguments.",
      value: cfg.repairEnabled,
      default: DEFAULTS.repairEnabled,
      valueDescriptions: {
        on: "Active — repair malformed arguments",
        off: "Suspended — pass args through unchanged",
      },
    },
    {
      key: "repairPolicy",
      label: "Repair Policy",
      type: "enum",
      options: ["conservative", "adaptive", "recover"],
      optionLabels: {
        conservative: "Conservative — no transforms, only aliases",
        adaptive: "Adaptive — balanced (default)",
        recover: "Recover — aggressive repair",
      },
      description: "How aggressive the repair pipeline is when fixing malformed arguments.",
      value: cfg.repairPolicy,
      default: DEFAULTS.repairPolicy,
    },
    {
      key: "staleReadEnabled",
      label: "Stale-Read Protection",
      type: "boolean",
      description: "Reject edits to files that changed since the last read.",
      value: cfg.staleReadEnabled,
      default: DEFAULTS.staleReadEnabled,
      valueDescriptions: {
        on: "Active — blocks edits to changed files",
        off: "Suspended — allows edits regardless",
      },
    },
    {
      key: "staleReadToleranceMs",
      label: "Stale-Read Tolerance",
      type: "number",
      description: "Millisecond tolerance for mtime-based stale-read detection.",
      value: cfg.staleReadToleranceMs,
      default: DEFAULTS.staleReadToleranceMs,
      min: 0,
      max: 5000,
      step: 10,
    },
    {
      key: "stormbreakerEnabled",
      label: "Stormbreaker",
      type: "boolean",
      description: "Enhance tool errors and break repeated-failure loops.",
      value: cfg.stormbreakerEnabled,
      default: DEFAULTS.stormbreakerEnabled,
      valueDescriptions: {
        on: "Active — enhances errors, breaks loops",
        off: "Suspended — raw errors only",
      },
    },
    {
      key: "stormbreakerThreshold",
      label: "Stormbreaker Threshold",
      type: "number",
      description: "Consecutive identical failures before breaking the loop.",
      value: cfg.stormbreakerThreshold,
      default: DEFAULTS.stormbreakerThreshold,
      min: 1,
      max: 10,
      step: 1,
    },
    {
      key: "stormbreakerAutoContinue",
      label: "Stormbreaker Auto-Continue",
      type: "boolean",
      description:
        "After a loop break, automatically resume with a corrective retry prompt instead of waiting for you to respond.",
      value: cfg.stormbreakerAutoContinue,
      default: DEFAULTS.stormbreakerAutoContinue,
      valueDescriptions: {
        on: "Active — session auto-resumes after the retry delay",
        off: "Manual — session pauses until you send a message",
      },
    },
    {
      key: "stormbreakerRetryDelayMs",
      label: "Stormbreaker Retry Delay",
      type: "number",
      description:
        "Pause length before the automatic retry turn fires after a loop break (clamped 1000-10000).",
      value: cfg.stormbreakerRetryDelayMs,
      default: DEFAULTS.stormbreakerRetryDelayMs,
      min: 1000,
      max: 10000,
      step: 500,
    },
    {
      key: "preflightEnabled",
      label: "Path Preflight",
      type: "boolean",
      description: "Validate and normalize paths before edit/write execution.",
      value: cfg.preflightEnabled,
      default: DEFAULTS.preflightEnabled,
      valueDescriptions: {
        on: "Active — validates paths, suggests near-matches",
        off: "Suspended — passes paths through unchanged",
      },
    },
    {
      key: "editOverrideEnabled",
      label: "Edit Override",
      type: "boolean",
      description:
        "Override the built-in edit tool with the Edit Guard pipeline (repair, fuzzy matching, anchor, stale-read, preflight).",
      value: cfg.editOverrideEnabled,
      default: DEFAULTS.editOverrideEnabled,
      valueDescriptions: {
        on: "Active — edit calls run through Edit Guard",
        off: "Suspended — native edit remains",
      },
    },
    {
      key: "telemetryEnabled",
      label: "Telemetry Audit Trail",
      type: "boolean",
      description: "Forward guard events to the session log (edit-guard:event entries).",
      value: cfg.telemetryEnabled,
      default: DEFAULTS.telemetryEnabled,
      valueDescriptions: {
        on: "Active — events appended to the session audit trail",
        off: "Suspended — no session entries",
      },
    },
    {
      key: "undoEnabled",
      label: "Undo History",
      type: "boolean",
      description: "Persist per-file undo history for the edit tool.",
      value: cfg.undoEnabled,
      default: DEFAULTS.undoEnabled,
      valueDescriptions: {
        on: "Active — edits can be undone",
        off: "Suspended — no undo history",
      },
    },
    {
      key: "undoMaxBytes",
      label: "Undo Store Budget",
      type: "number",
      description:
        "Byte budget for the JSONL undo dump. When exceeded, the oldest records are evicted (FIFO). Undo records survive sessions.",
      value: cfg.undoMaxBytes,
      default: DEFAULTS.undoMaxBytes,
      min: MIN_MAX_BYTES,
      max: MAX_LIMIT_BYTES,
      step: 500000,
    },
    {
      key: "outsideCwdAdvisoryEnabled",
      label: "Outside-CWD Advisory",
      type: "boolean",
      description:
        "Append a one-line advisory to tool results when a path falls outside the current working directory.",
      value: cfg.outsideCwdAdvisoryEnabled,
      default: DEFAULTS.outsideCwdAdvisoryEnabled,
      valueDescriptions: {
        on: "Active — advisories appended to tool output",
        off: "Suspended — no outside-cwd advisories",
      },
    },
  ],
  env: {
    repairPolicy: {
      var: "EDIT_GUARD_REPAIR_POLICY",
      parse: (raw, _current) => {
        const lower = raw.toLowerCase();
        if (["conservative", "adaptive", "recover"].includes(lower)) return lower;
        return _current;
      },
    },
    repairEnabled: "EDIT_GUARD_REPAIR_ENABLED",
    staleReadEnabled: "EDIT_GUARD_STALE_READ_ENABLED",
    staleReadToleranceMs: "EDIT_GUARD_STALE_READ_TOLERANCE_MS",
    stormbreakerEnabled: "EDIT_GUARD_STORMBREAKER_ENABLED",
    stormbreakerThreshold: "EDIT_GUARD_STORMBREAKER_THRESHOLD",
    stormbreakerAutoContinue: "EDIT_GUARD_STORMBREAKER_AUTO_CONTINUE",
    // Custom parser instead of the plain string mapping: env overrides are
    // applied AFTER validate(), so the clamp must live here too.
    stormbreakerRetryDelayMs: {
      var: "EDIT_GUARD_STORMBREAKER_RETRY_DELAY_MS",
      parse: (raw) => {
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) return undefined;
        return Math.min(10000, Math.max(1000, parsed));
      },
    },
    preflightEnabled: "EDIT_GUARD_PREFLIGHT_ENABLED",
    editOverrideEnabled: "EDIT_GUARD_EDIT_OVERRIDE_ENABLED",
    telemetryEnabled: "EDIT_GUARD_TELEMETRY_ENABLED",
    undoEnabled: "EDIT_GUARD_UNDO_ENABLED",
    undoMaxBytes: "EDIT_GUARD_UNDO_MAX_BYTES",
    overwriteGuardEnabled: "EDIT_GUARD_OVERWRITE_GUARD_ENABLED",
    warningsEnabled: "EDIT_GUARD_WARNINGS_ENABLED",
    coherenceCheckEnabled: "EDIT_GUARD_COHERENCE_CHECK_ENABLED",
    outsideCwdAdvisoryEnabled: "EDIT_GUARD_OUTSIDE_CWD_ADVISORY_ENABLED",
  },
});

/** Mutable current config, updated on session_start and after modal save. */
let currentConfig = config.load();

/**
 * Get the current effective config (cached, refreshed on session_start / modal save).
 */
export function getConfig(): EditGuardConfig {
  return currentConfig;
}

/**
 * Force-reload config from disk and update the cached value.
 */
export function refreshConfig(cwd?: string): EditGuardConfig {
  currentConfig = config.load(cwd);
  return currentConfig;
}

/**
 * Load and return the effective config for the given working directory.
 */
export function loadConfig(cwd?: string): EditGuardConfig {
  return config.load(cwd);
}
