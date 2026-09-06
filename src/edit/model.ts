/**
 * Shared domain types — pure, no Pi imports. Single source of truth for
 * the edit pipeline's data shapes. Flow: ParsedBlock (repair/pipeline input)
 * → MatchResult (matching/chain output) → ResolvedEdit (pipeline/resolve,
 * with file offsets) → ApplyResult (pipeline/apply, with splices) → raw-splice
 * back onto original bytes (patching/raw-splice). Diagnostics and error kinds
 * are surfaced to the tool layer (platform/tools/edit) and telemetry.
 */

/** One parsed or constructed edit: find oldText in path, replace with newText. */
export interface Edit {
  path: string;
  oldText: string;
  newText: string;
}

/** A block parsed from an aider-format patch string. */
export interface ParsedBlock {
  path: string;
  oldText: string;
  newText: string;
  /** Optional anchor text narrowing the search window (±10 lines). */
  anchor?: string;
  /** When true, replace every occurrence of the matched text in the file. */
  replaceAll?: boolean;
}

/**
 * A successful fuzzy match. `actual` is the substring found in the ORIGINAL
 * content (never the query text), so replacements preserve real formatting.
 */
export interface MatchResult {
  actual: string;
  passName: string; // which pass matched — for logging (OpenDev parity)
}

/** A candidate near-miss for closest-candidate-on-failure feedback. */
export interface ClosestCandidate {
  passName: string;
  similarity: number; // 0..1
  candidate: string; // real file text that was closest
  startLine: number; // 1-indexed
  endLine: number; // 1-indexed
  /** Sørensen-Dice over token multisets (query vs candidate) — order-insensitive. */
  tokenDice?: number;
  /** Jaccard index over token multisets — stricter than dice. */
  tokenJaccard?: number;
}

/** Outcome of applying all edits to original content. */
export interface ApplyResult {
  content: string; // resulting content (success) or original (failure)
  applied: AppliedEdit[];
  failed: FailedEdit[];
}

export interface AppliedEdit {
  edit: Edit;
  match: MatchResult;
  start: number;
  end: number;
  /** Original edits[] index this application belongs to. */
  blockIndex?: number;
}

/** A matched edit with its located span in the (LF-normalized) content. */
export interface ResolvedEdit {
  edit: Edit;
  match: MatchResult;
  start: number;
  end: number;
  /** Original edits[] index this resolution belongs to. */
  blockIndex?: number;
}

/** Classification of failures returned by applyEdits. */
export type EditFailureKind = "overlap" | "no-op" | "invariant" | "already-handled";

export interface FailedEdit {
  edit: Edit;
  reason: string;
  kind: EditFailureKind;
  /** Original edits[] index, threaded from the resolution stage when known. */
  blockIndex?: number;
}

/**
 * Disproportionate-match refusal: a fuzzy pass matched a span much larger than the query.
 * Prevents silent wrong-location edits (OpenCode precedent).
 */
/** Error kinds surfaced to the tool layer. */
export type EditErrorKind =
  | "stale-read"
  | "ambiguous"
  | "not-found"
  | "overlapping"
  | "no-op"
  | "validation"
  | "anchor-not-found"
  | "anchor-ambiguous"
  | "disproportionate"
  | "already-applied";

export interface EditError {
  kind: EditErrorKind;
  message: string;
  /** 1-indexed line positions for ambiguous matches. */
  linePositions?: number[];
  /** Best near-miss when nothing matched. */
  closestCandidate?: ClosestCandidate;
  /** Block index this error originated from. */
  index?: number;
}

/** Preview around a matched span for diagnostic output. */
export interface CandidatePreview {
  before: Array<{ line: number; content: string }>;
  matched: Array<{ line: number; content: string }>;
  matchedLinesOmitted: number;
  after: Array<{ line: number; content: string }>;
}

// ─── Diagnostics ───────────────────────────────────────────────────────────

export type EditDiagnosticStatus =
  | "applied"
  | "missing"
  | "ambiguous"
  | "overlap"
  | "noop"
  | "validation";

export interface EditDiagnostic {
  index: number;
  oldText: string;
  newText: string;
  status: EditDiagnosticStatus;
  reason?: string;
  match?: {
    start: number;
    end: number;
    passName: string;
    anchorUsed?: boolean;
  };
  lineRange?: { start: number; end: number };
  alternatives?: NearMissAlternative[];
  anchorFallback?: boolean;
  anchorWindowOverflow?: boolean;
  /** Anchor ≈ oldText and matched nowhere — dropped, matching ran on oldText. */
  anchorRedundant?: boolean;
  fallbackCandidate?: NearMissAlternative;
}

export interface NearMissAlternative {
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  candidate: string;
  similarity: number;
  preview?: CandidatePreview;
}

// ─── Our extension's types ───────────────────────────────────────────────────

/** A single edit block passed to the `patch` tool. */
export interface PatchEdit {
  oldText: string;
  newText: string;
  /** Optional anchor text to narrow the search range. */
  anchor?: string;
  /** When true, replace every occurrence of oldText/newText in the file. */
  replaceAll?: boolean;
}
