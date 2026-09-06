/** Named repair-aggressiveness profiles. */
export type RepairPolicyProfile = "conservative" | "adaptive" | "recover";

export type GrammarPolicyMode = "off" | "observe" | "strip" | "recover";

/** How the pipeline handles unknown grammar text (e.g. leaked tokens). */
export type UnknownGrammarTextPolicy = "preserve" | "strip";

/** Effective repair policy for one pipeline run. */
export interface RepairPolicy {
  profile: RepairPolicyProfile;
  allowTruncatedEnvelopeCompletion: boolean;
  allowValidValueTransforms: boolean;
  grammarMode: GrammarPolicyMode;
  unknownGrammarText: UnknownGrammarTextPolicy;
}

/** Per-run overrides applied on top of a profile's defaults. */
export interface RepairPolicyOverrides {
  grammarMode?: GrammarPolicyMode;
  unknownGrammarText?: UnknownGrammarTextPolicy;
}

/** Default flag values for each repair-policy profile. */
const PROFILE_DEFAULTS: Record<RepairPolicyProfile, RepairPolicy> = {
  conservative: {
    profile: "conservative",
    allowTruncatedEnvelopeCompletion: false,
    allowValidValueTransforms: false,
    grammarMode: "observe",
    unknownGrammarText: "preserve",
  },
  adaptive: {
    profile: "adaptive",
    allowTruncatedEnvelopeCompletion: true,
    allowValidValueTransforms: true,
    grammarMode: "strip",
    unknownGrammarText: "preserve",
  },
  recover: {
    profile: "recover",
    allowTruncatedEnvelopeCompletion: true,
    allowValidValueTransforms: true,
    grammarMode: "recover",
    unknownGrammarText: "preserve",
  },
};

/**
 * Resolve the effective repair policy for a run.
 *
 * `overrides` are merged on top of the selected profile's defaults so
 * callers can tune individual knobs without switching profiles.
 */
export function resolveRepairPolicy(
  profile: RepairPolicyProfile = "adaptive",
  overrides: RepairPolicyOverrides = {},
): RepairPolicy {
  return {
    ...PROFILE_DEFAULTS[profile],
    ...overrides,
    profile,
  };
}
