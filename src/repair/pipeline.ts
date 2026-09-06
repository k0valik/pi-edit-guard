/**
 * Generic repair pipeline — ordered, pure validate-then-recover flow.
 *
 * Stages: envelope recovery (JSON-decode + truncated-object completion) →
 * downstream (owner prepare-arguments shim → preprocessors → schema repair →
 * final validation). The pipeline itself does no I/O, persistence or
 * telemetry; callers provide onObservation / onOutcome callbacks.
 * Edit-specific wiring lives in repair/entry.ts. The owner shim stage exists
 * for pi-owned prepareArguments compatibility (allowValidValueTransforms gates
 * whether it may mutate valid inputs); removing the stage re-breaks tools
 * that depend on pi's own shim. Keep the stage order — envelope must run
 * before any structural transforms.
 */

import { Value } from "typebox/value";
import { recoverEnvelope, truncatedEnvelopeChange } from "./envelope.js";
import { stableSerialize } from "./lifecycle.js";
import { resolveRepairPolicy } from "./policy.js";
import { preprocessInput } from "./preprocess.js";
import { repairSchemaInput } from "./repair-engine.js";
import type {
  RepairChange,
  RepairObservation,
  RepairPipelineConfig,
  RepairPipelineResult,
} from "./types.js";

/**
 * Coerce `value` through TypeBox Convert/Check and report validity.
 * Failures return the original value so callers can decide whether to
 * proceed or treat the input as unrepairable.
 */
function convertAndValidate(
  config: RepairPipelineConfig,
  value: unknown,
): { valid: boolean; value: unknown } {
  try {
    const converted = Value.Convert(config.schema, structuredClone(value));
    return { valid: Value.Check(config.schema, converted), value: converted };
  } catch {
    return { valid: false, value };
  }
}

/**
 * Forward observations to the configured callback. Failures are swallowed
 * because observation callbacks cannot affect repair safety or validity.
 */
function emitObservations(config: RepairPipelineConfig, observations: RepairObservation[]): void {
  if (!config.onObservation) return;
  for (const observation of observations) {
    try {
      config.onObservation(observation);
    } catch {
      // Observation callbacks cannot affect repair safety or validity.
    }
  }
}

/**
 * Run one input through the downstream stages: owner prepare-arguments shim,
 * preprocessors, and schema repair. Historically this included only
 * preprocessors+schema; the owner shim was added for pi-owned prepareArguments
 * compatibility and must stay before preprocessors — moving it after would let
 * preprocessors see un-shimmed shapes and miss repairs.
 *
 * Returns the repaired result or an unrepairable terminal state.
 */
function applyDownstream(
  input: unknown,
  config: RepairPipelineConfig,
  initialChanges: readonly RepairChange[],
): RepairPipelineResult {
  const policy = resolveRepairPolicy(config.policy, config.policyOverrides);
  const changes = initialChanges.map((change) =>
    change.ruleId === "envelope.decode-json"
      ? {
          ...change,
          note: `Parsed your JSON-stringified arguments for tool "${config.toolName}". Send the arguments as a JSON object next time, not a string.`,
        }
      : change,
  );
  const observations: RepairObservation[] = [];
  let current = input;
  let ownerChanged = false;

  if (config.ownerPrepareArguments) {
    try {
      const before = stableSerialize(current);
      const prepared = config.ownerPrepareArguments(current);
      current = prepared;
      ownerChanged = stableSerialize(current) !== before;
    } catch {
      // Compatibility shims are advisory. Preserve the recovered envelope so
      // strict validation can still make the fail-closed decision.
    }
  }

  const preprocessed = preprocessInput({
    input: current,
    toolName: config.toolName,
    preprocessors: config.preprocessors ?? [],
    modelId: config.modelId,
    allowValidValueTransforms: policy.allowValidValueTransforms,
  });
  current = preprocessed.value;
  changes.push(...preprocessed.changes);
  for (const ruleId of preprocessed.observations) {
    observations.push({
      channel: "tool",
      stage: "valid-value",
      ruleId,
      toolName: config.toolName,
      outcome: "detected",
    });
  }

  const schemaResult = repairSchemaInput({
    toolName: config.toolName,
    schema: config.schema,
    input: current,
    config: config.legacyConfig,
  });
  if (schemaResult.outcome === "unrepairable") {
    const result: RepairPipelineResult = {
      outcome: "unrepairable",
      args: input,
      policy: policy.profile,
      changes: [],
      observations,
      issueSummary: schemaResult.issueSummary,
      fingerprint: schemaResult.fingerprint,
      retryMessage: schemaResult.retryMessage,
    };
    emitObservations(config, observations);
    return result;
  }

  for (const schemaChange of schemaResult.changes) {
    changes.push({
      ruleId: schemaChange.ruleId,
      stage: "schema-repair",
      note: schemaChange.note,
    });
  }

  const final = convertAndValidate(config, schemaResult.args);
  if (!final.valid) {
    const result: RepairPipelineResult = {
      outcome: "unrepairable",
      args: input,
      policy: policy.profile,
      changes: [],
      observations,
      issueSummary: schemaResult.issueSummary,
      fingerprint: schemaResult.fingerprint,
      retryMessage: schemaResult.retryMessage,
    };
    emitObservations(config, observations);
    return result;
  }

  const result: RepairPipelineResult = {
    outcome: changes.length > 0 ? "repaired" : "valid",
    args: changes.length > 0 ? final.value : ownerChanged ? schemaResult.args : input,
    policy: policy.profile,
    changes,
    observations,
    issueSummary: schemaResult.issueSummary,
    fingerprint: schemaResult.fingerprint,
  };
  emitObservations(config, observations);
  return result;
}

/**
 * Run the ordered, pure validate-then-repair pipeline. It performs no event
 * registration, persistence, UI, telemetry, filesystem, or network work.
 */
export function runRepairPipeline(options: {
  input: unknown;
  config: RepairPipelineConfig;
}): RepairPipelineResult {
  const { input, config } = options;
  const finish = (result: RepairPipelineResult): RepairPipelineResult => {
    try {
      config.onOutcome?.(result);
    } catch {
      // Reporting callbacks cannot affect repair safety or validity.
    }
    return result;
  };
  const policy = resolveRepairPolicy(config.policy, config.policyOverrides);
  const envelope = recoverEnvelope(input, config.limits);
  if (policy.allowTruncatedEnvelopeCompletion) {
    for (const candidate of envelope.candidates) {
      const completed = applyDownstream(candidate, config, [truncatedEnvelopeChange()]);
      if (completed.outcome !== "unrepairable") return finish(completed);
    }
  }

  const primary = applyDownstream(envelope.value, config, envelope.changes);
  if (primary.outcome !== "unrepairable") {
    return finish(
      primary.outcome === "valid" && stableSerialize(primary.args) === stableSerialize(input)
        ? { ...primary, args: input }
        : primary,
    );
  }

  return finish({
    ...primary,
    args: input,
    changes: [],
  });
}
