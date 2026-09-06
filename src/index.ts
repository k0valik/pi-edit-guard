// Barrel re-exports for tests and external consumers.

// Edit engine (pi-semantic-edit port)
export { findMatch } from "./edit/matching/chain.js";
export { findClosestCandidate } from "./edit/matching/closest.js";
export { applyEdits } from "./edit/pipeline/apply.js";
export { resolveBlocks } from "./edit/pipeline/resolve.js";
export {
  executeFile,
  type ExecuteFileOptions,
  type ExecuteFileResult,
} from "./edit/pipeline/execute.js";
export { autopatchBlocks } from "./edit/patching/autopatch/index.js";
export { ReadRegistry } from "./guards/stale-read/registry.js";
export {
  createUndoStore,
  saveUndo,
  getUndo,
  clearUndo,
  type UndoRecord,
  type UndoStore,
} from "./history/store.js";
export { patchEditsToBlocks } from "./edit/pipeline/blocks.js";
// Raw-splice engine (decorated-pi port) — preserves original file bytes
export {
  normalizeLineEndings,
  buildNormToRawMap,
  spliceOntoRaw,
  buildLineOffsets,
  lineAtOffset,
  offsetAtLine,
} from "./edit/patching/raw-splice.js";

// Robust matching (pi-robust-edit port) — reinforcement passes
export {
  robustTrimmedFind,
  robustBackslashFind,
  findAllOccurrences,
} from "./edit/matching/robust-match.js";

// Repair pipeline (pi-repair-layer port)
export { runRepairPipeline } from "./repair/pipeline.js";
export { repairSchemaInput } from "./repair/repair-engine.js";
export { recoverEnvelope } from "./repair/envelope.js";
export { resolveRepairPolicy } from "./repair/policy.js";
export { getFieldAliases } from "./repair/aliases.js";
export { RepairLifecycle } from "./repair/lifecycle.js";

// Edit override argument preparation.
export { EDIT_SCHEMA, prepareEditArguments, repairLifecycle } from "./repair/entry.js";

// Instrumentation core.
export { EditGuardTelemetry, telemetry, type GuardEvent, type GuardStats } from "./telemetry.js";

// Error handling
export {
  createStormBreakerState,
  tryEnhanceError,
  extractResultText,
  recordFailure,
  clearFailures,
  MAX_WINDOW_SIZE,
  type WindowedFailure,
} from "./resilience/stormbreaker.js";
export { errorSignature, enhanceError } from "./resilience/enhance.js";

// Preflight
export { preflight } from "./guards/preflight/preflight.js";
export { normalizePathValue, getPathArg } from "./guards/preflight/paths.js";
export { nearMatches } from "./guards/preflight/suggest.js";

// Overwrite guard
export { OverwriteGuard } from "./guards/overwrite/guard.js";

// Config
export {
  config,
  loadConfig,
  getConfig,
  refreshConfig,
  CONFIG_FILENAME,
  DEFAULTS,
  type EditGuardConfig,
} from "./config/settings.js";
export { readEnv, type EditGuardEnv } from "./config/env.js";

// Extension wiring
export { default } from "./extension.js";

// Commands
export { registerEditGuardCommand } from "./platform/commands/edit-guard/index.js";
