/**
 * Environment variable parsing for the edit-guard extension.
 *
 * All configuration knobs are exposed as EDIT_GUARD_* env vars with
 * sensible defaults. ConfigManager layered settings override these.
 */

import { DEFAULT_MAX_BYTES, clampMaxBytes } from "../history/store.js";

/** All EDIT_GUARD_* env vars and their defaults. */
export interface EditGuardEnv {
  // Repair pipeline
  readonly repairPolicy: "conservative" | "adaptive" | "recover";
  readonly repairEnabled: boolean;

  // Stale-read
  readonly staleReadEnabled: boolean;
  readonly staleReadToleranceMs: number;

  // Storm-breaker
  readonly stormbreakerEnabled: boolean;
  readonly stormbreakerThreshold: number;
  /** Auto-resume with a corrective retry prompt after a loop break. */
  readonly stormbreakerAutoContinue: boolean;
  /** Pause length before the automatic retry turn fires (clamped 1000-10000). */
  readonly stormbreakerRetryDelayMs: number;

  // Preflight
  readonly preflightEnabled: boolean;

  // Edit override killswitch
  readonly editOverrideEnabled: boolean;

  // Telemetry audit trail
  readonly telemetryEnabled: boolean;

  // Undo
  readonly undoEnabled: boolean;
  /** Byte budget for the JSONL undo dump store (FIFO eviction). */
  readonly undoMaxBytes: number;

  // Overwrite guard
  readonly overwriteGuardEnabled: boolean;
  /** Toggle all edit-tool UI warnings. */
  readonly warningsEnabled: boolean;
  /** Toggle the post-edit coherence checker. */
  readonly coherenceCheckEnabled: boolean;
  /** Emit a one-line advisory when a tool accesses a path outside cwd. */
  readonly outsideCwdAdvisoryEnabled: boolean;
}

const DEFAULTS: Readonly<EditGuardEnv> = {
  repairPolicy: "adaptive",
  repairEnabled: true,
  staleReadEnabled: true,
  staleReadToleranceMs: 500,
  stormbreakerEnabled: true,
  stormbreakerThreshold: 3,
  stormbreakerAutoContinue: true,
  stormbreakerRetryDelayMs: 3000,
  preflightEnabled: true,
  editOverrideEnabled: true,
  telemetryEnabled: true,
  undoEnabled: true,
  undoMaxBytes: DEFAULT_MAX_BYTES,
  overwriteGuardEnabled: false,
  warningsEnabled: true,
  coherenceCheckEnabled: false,
  outsideCwdAdvisoryEnabled: true,
};

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return !["0", "false", "no", "off"].includes(raw.toLowerCase());
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envOneOf<T extends string>(name: string, fallback: T, allowed: readonly T[]): T {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const lower = raw.toLowerCase() as T;
  return allowed.includes(lower) ? lower : fallback;
}

/**
 * Read all EDIT_GUARD_* env vars and return the effective config.
 * Env vars override defaults but are overridden by ConfigManager layered settings.
 */
export function readEnv(): EditGuardEnv {
  return {
    repairPolicy: envOneOf("EDIT_GUARD_REPAIR_POLICY", DEFAULTS.repairPolicy, [
      "conservative",
      "adaptive",
      "recover",
    ]),
    repairEnabled: envBool("EDIT_GUARD_REPAIR_ENABLED", DEFAULTS.repairEnabled),
    staleReadEnabled: envBool("EDIT_GUARD_STALE_READ_ENABLED", DEFAULTS.staleReadEnabled),
    staleReadToleranceMs: envInt(
      "EDIT_GUARD_STALE_READ_TOLERANCE_MS",
      DEFAULTS.staleReadToleranceMs,
    ),
    stormbreakerEnabled: envBool("EDIT_GUARD_STORMBREAKER_ENABLED", DEFAULTS.stormbreakerEnabled),
    stormbreakerThreshold: envInt(
      "EDIT_GUARD_STORMBREAKER_THRESHOLD",
      DEFAULTS.stormbreakerThreshold,
    ),
    stormbreakerAutoContinue: envBool(
      "EDIT_GUARD_STORMBREAKER_AUTO_CONTINUE",
      DEFAULTS.stormbreakerAutoContinue,
    ),
    // Clamped to the same bounds as the ConfigManager surface.
    stormbreakerRetryDelayMs: Math.min(
      10000,
      Math.max(
        1000,
        envInt("EDIT_GUARD_STORMBREAKER_RETRY_DELAY_MS", DEFAULTS.stormbreakerRetryDelayMs),
      ),
    ),
    preflightEnabled: envBool("EDIT_GUARD_PREFLIGHT_ENABLED", DEFAULTS.preflightEnabled),
    editOverrideEnabled: envBool("EDIT_GUARD_EDIT_OVERRIDE_ENABLED", DEFAULTS.editOverrideEnabled),
    telemetryEnabled: envBool("EDIT_GUARD_TELEMETRY_ENABLED", DEFAULTS.telemetryEnabled),
    undoEnabled: envBool("EDIT_GUARD_UNDO_ENABLED", DEFAULTS.undoEnabled),
    // Clamped to the same bounds as the ConfigManager surface; a raw 0/negative
    // value would otherwise evict the store down to a single record per put.
    undoMaxBytes: clampMaxBytes(envInt("EDIT_GUARD_UNDO_MAX_BYTES", DEFAULTS.undoMaxBytes)),
    overwriteGuardEnabled: envBool(
      "EDIT_GUARD_OVERWRITE_GUARD_ENABLED",
      DEFAULTS.overwriteGuardEnabled,
    ),
    warningsEnabled: envBool("EDIT_GUARD_WARNINGS_ENABLED", DEFAULTS.warningsEnabled),
    coherenceCheckEnabled: envBool(
      "EDIT_GUARD_COHERENCE_CHECK_ENABLED",
      DEFAULTS.coherenceCheckEnabled,
    ),
    outsideCwdAdvisoryEnabled: envBool(
      "EDIT_GUARD_OUTSIDE_CWD_ADVISORY_ENABLED",
      DEFAULTS.outsideCwdAdvisoryEnabled,
    ),
  };
}
