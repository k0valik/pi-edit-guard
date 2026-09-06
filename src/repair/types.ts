/**
 * Shared repair-pipeline types — stage names, pipeline config/result,
 * observations. Single import point so lifecycle (entry.ts), engine
 * (repair-engine.ts) and pipeline (pipeline.ts) agree on shapes.
 */

import type { TSchema } from "typebox";
import type { RepairPolicyOverrides, RepairPolicyProfile } from "./policy.js";
import type { Preprocessor } from "./preprocess.js";
import type { ToolRepairConfig } from "./repair-engine.js";

export type RepairStage =
  | "envelope"
  | "owner-shim"
  | "preprocess"
  | "valid-value"
  | "strict-validation"
  | "schema-repair"
  | "final-validation";

export interface RepairChange {
  ruleId: string;
  stage: RepairStage;
  note: string;
}

/** Value-free metadata suitable for local telemetry callbacks. */
export interface RepairObservation {
  channel: "tool" | "message";
  stage: RepairStage | "grammar";
  ruleId: string;
  toolName?: string;
  grammar?: string;
  outcome?: "detected" | "valid" | "repaired" | "unrepairable";
}

export interface RepairPipelineLimits {
  maxInputBytes?: number;
  maxNestingDepth?: number;
  maxDecodeAttempts?: number;
  maxCandidates?: number;
  maxWorkMs?: number;
}

export interface RepairPipelineConfig {
  toolName: string;
  schema: TSchema;
  policy?: RepairPolicyProfile;
  policyOverrides?: RepairPolicyOverrides;
  preprocessors?: readonly Preprocessor[];
  /** Compatibility input accepted throughout the current major version. */
  legacyConfig?: ToolRepairConfig;
  modelId?: string;
  ownerPrepareArguments?: (input: unknown) => unknown;
  limits?: RepairPipelineLimits;
  onObservation?: (observation: RepairObservation) => void;
  /** Optional consumer-owned reporting hook; the core itself stores nothing. */
  onOutcome?: (outcome: RepairPipelineResult) => void;
}

export interface RepairPipelineResult {
  outcome: "valid" | "repaired" | "unrepairable";
  args: unknown;
  policy: RepairPolicyProfile;
  changes: RepairChange[];
  observations: RepairObservation[];
  issueSummary?: string;
  fingerprint?: string;
  retryMessage?: string;
}
