// Telemetry core — pure, no pi imports.
//
// Every pipeline stage emits an event (repair, preflight, match chain, anchor,
// stale-read, stormbreaker, apply). record() updates in-memory counters
// (→ /edit-guard), a bounded ring buffer (→ recent-events window), and
// a pending batch. The pending batch is written to the session audit trail as
// ONE edit-guard:event entry per agent lifecycle checkpoint via flushNow();
// extension.ts owns the appendEntry wiring.

/** Edit-guard envelope — a single consolidated event per edit tool call. */
export interface EditGuardEnvelope {
  type: "edit.envelope";
  timestamp: number;
  path: string;
  editIndex: number;
  /** Checkpoint classification: did this call land, land partially, or fail? */
  outcome: "applied" | "partial" | "failed";
  editsApplied: number;
  passNames: string[];
  anchorUsed: boolean;
  durationMs: number;
  repairRules: Array<{ ruleId: string; outcome: "repaired" | "unrepairable" }>;
  corruptionWarnings: string[];
  coherenceWarnings: string[];
  postWriteWarnings: string[];
  semanticWarnings: string[];
  closestCandidate?: { similarity: number; lineRange?: { start: number; end: number } };
  anchorIssues?: Array<{
    type: "not_found" | "ambiguous";
    anchorLen: number;
    occurrences?: number;
  }>;
  isPartial?: boolean;
  appliedCount?: number;
  failedCount?: number;
  /** Repair notes produced by prepareArguments argument repair. */
  repairNotes?: string[];
}

/** Every event carries a timestamp plus a minimal payload. */
export type GuardEvent =
  | {
      type: "repair.rule";
      timestamp: number;
      ruleId: string;
      outcome: "repaired" | "unrepairable";
      fingerprint?: string;
    }
  | {
      type: "match.pass";
      timestamp: number;
      passName: string;
      autoExpand: boolean;
      anchorUsed: boolean;
    }
  | {
      type: "match.closest_candidate";
      timestamp: number;
      similarity: number;
      lineRange?: { start: number; end: number };
    }
  | { type: "anchor.not_found"; timestamp: number; path: string }
  | {
      type: "anchor.redundant_dropped";
      timestamp: number;
      path: string;
      similarity: number;
    }
  | {
      type: "anchor.ambiguous";
      timestamp: number;
      path: string;
      occurrences: number;
    }
  | { type: "match.already_applied"; timestamp: number; path: string }
  | {
      type: "preflight.normalized";
      timestamp: number;
      toolName: string;
      reason?: string;
    }
  | {
      type: "preflight.blocked";
      timestamp: number;
      toolName: string;
      reason: string;
    }
  | { type: "stale_read.blocked"; timestamp: number; path: string }
  | { type: "stale_read.self_healed"; timestamp: number; path: string }
  | {
      type: "write_guard.denied";
      timestamp: number;
      path: string;
      reason: "headless" | "user_block" | "user_block_with_reason";
    }
  | {
      type: "stormbreaker.enhanced";
      timestamp: number;
      toolName: string;
      count: number;
    }
  | {
      type: "stormbreaker.loop_broken";
      timestamp: number;
      toolName: string;
      count: number;
      errorExcerpt?: string;
    }
  | {
      type: "stormbreaker.auto_retry";
      timestamp: number;
      toolName: string;
      count: number;
      delayMs: number;
    }
  | {
      type: "edit.applied";
      timestamp: number;
      editsApplied: number;
      passNames: string[];
      anchorUsed: boolean;
      durationMs: number;
      coherenceWarnings: number;
    }
  | {
      type: "overwrite_guard.blocked";
      timestamp: number;
      path: string;
    }
  | {
      type: "edit.partial";
      timestamp: number;
      appliedCount: number;
      failedCount: number;
      passNames: string[];
      durationMs: number;
    }
  | {
      type: "edit.autopatch";
      timestamp: number;
      passName: string;
      index: number;
    }
  | {
      type: "path.advisory";
      timestamp: number;
      toolName: string;
      path: string;
    }
  | EditGuardEnvelope;

export interface GuardStats {
  eventsRecorded: number;
  /** Edits applied per match pass name (from edit.applied passNames). */
  editsAppliedByPass: Record<string, number>;
  /** Repair rules fired, by ruleId. */
  repairRules: Record<string, number>;
  /** Fingerprints of unrepairable failures, by FNV-1a hash. */
  unrepairableFingerprints: Record<string, number>;
  preflightNormalized: number;
  preflightBlocked: number;
  staleReadBlocked: number;
  staleReadSelfHealed: number;
  stormbreakerEnhanced: number;
  stormbreakerLoopBroken: number;
  /** Count of stormbreaker auto-retry scheduling events. */
  stormbreakerAutoRetry: number;
  /** Total edits applied across all edit.applied events. */
  editsApplied: number;
  /** Count of edits that used an anchor window. */
  anchorUsed: number;
  /** Anchor failures: anchor text not found in the file. */
  anchorNotFound: number;
  /** Anchors dropped as redundant (anchor ≈ oldText, anchor matched nowhere). */
  anchorRedundantDropped: number;
  /** Edits reported as already applied (REPLACE text already present). */
  alreadyApplied: number;
  /** Anchor failures: anchor text matched more than once. */
  anchorAmbiguous: number;
  /** Count of edits resolved via auto-expand. */
  autoExpand: number;
  /** Mean duration of successful edit calls (ms). */
  meanEditDurationMs: number;
  /** Mean similarity of closest-candidate events (0..1). */
  meanClosestSimilarity: number;
  closestCandidateCount: number;
  /** Count of writes blocked by the overwrite guard. */
  overwriteGuardBlocked: number;
  /** Count of writes blocked by the write guard (outside workspace). */
  writeGuardDenied: number;
  /** Count of partial edit applications (some edits applied, some failed). */
  partialEdits: number;
  /** Count of autopatch corrections applied. */
  autopatchCount: number;
  /** Count of edit-guard envelopes emitted. */
  envelopesEmitted: number;
  /** Total corruption warnings across all envelopes. */
  totalCorruptionWarnings: number;
  /** Total coherence warnings across all envelopes. */
  totalCoherenceWarnings: number;
  /** Total post-write warnings across all envelopes. */
  totalPostWriteWarnings: number;
  /** Count of outside-cwd advisories emitted (non-blocking). */
  pathAdvisoryCount: number;
}

const RING_BUFFER_MAX = 50;
// Loss radius of a single faulty flush — kept small on purpose: a granular
// 128-event batch beats one monolithic batch whose failure drops everything.
const PENDING_MAX = 128;

export class EditGuardTelemetry {
  readonly #events: GuardEvent[] = [];
  #eventsRecorded = 0;
  #editsAppliedByPass: Record<string, number> = {};
  #repairRules: Record<string, number> = {};
  #unrepairableFingerprints: Record<string, number> = {};
  #preflightNormalized = 0;
  #preflightBlocked = 0;
  #staleReadBlocked = 0;
  #staleReadSelfHealed = 0;
  #stormbreakerEnhanced = 0;
  #stormbreakerLoopBroken = 0;
  #stormbreakerAutoRetry = 0;
  #editsApplied = 0;
  #anchorUsed = 0;
  #anchorNotFound = 0;
  #anchorRedundantDropped = 0;
  #alreadyApplied = 0;
  #anchorAmbiguous = 0;
  #autoExpand = 0;
  #editDurationSum = 0;
  #editDurationCount = 0;
  #closestSimilaritySum = 0;
  #closestCandidateCount = 0;
  #overwriteGuardBlocked = 0;
  #partialEdits = 0;
  #autopatchCount = 0;
  #writeGuardDenied = 0;
  #envelopesEmitted = 0;
  #totalCorruptionWarnings = 0;
  #totalCoherenceWarnings = 0;
  #totalPostWriteWarnings = 0;
  #pathAdvisoryCount = 0;
  #pending: GuardEvent[] = [];
  #flushHandler: ((events: GuardEvent[]) => void) | undefined;

  constructor() {
    // Batching is configured post-construction via setFlushHandler(); there
    // is deliberately no per-event sink anymore.
  }

  /**
   * Attach (or replace) the batch flush handler. The handler receives the
   * whole pending batch and must never throw — flushNow isolates it (a
   * throw retains the batch for the next checkpoint) so telemetry can't
   * affect edit safety or validity.
   */
  setFlushHandler(handler: (events: GuardEvent[]) => void): void {
    this.#flushHandler = handler;
  }

  record(event: GuardEvent): void {
    this.#eventsRecorded++;
    this.#events.push(event);
    if (this.#events.length > RING_BUFFER_MAX) this.#events.shift();
    this.#pending.push(event);
    if (this.#pending.length >= PENDING_MAX) {
      this.flushNow(); // overflow safety valve
    }

    switch (event.type) {
      case "repair.rule": {
        this.#repairRules[event.ruleId] = (this.#repairRules[event.ruleId] ?? 0) + 1;
        if (event.outcome === "unrepairable" && event.fingerprint) {
          this.#unrepairableFingerprints[event.fingerprint] =
            (this.#unrepairableFingerprints[event.fingerprint] ?? 0) + 1;
        }
        break;
      }
      case "match.pass": {
        if (event.autoExpand) this.#autoExpand++;
        if (event.anchorUsed) this.#anchorUsed++;
        break;
      }
      case "match.closest_candidate": {
        this.#closestSimilaritySum += event.similarity;
        this.#closestCandidateCount++;
        break;
      }
      case "anchor.not_found":
        this.#anchorNotFound++;
        break;
      case "anchor.redundant_dropped":
        this.#anchorRedundantDropped++;
        break;
      case "match.already_applied":
        this.#alreadyApplied++;
        break;
      case "anchor.ambiguous":
        this.#anchorAmbiguous++;
        break;
      case "preflight.normalized":
        this.#preflightNormalized++;
        break;
      case "preflight.blocked":
        this.#preflightBlocked++;
        break;
      case "stale_read.blocked":
        this.#staleReadBlocked++;
        break;
      case "stale_read.self_healed":
        this.#staleReadSelfHealed++;
        break;
      case "stormbreaker.enhanced":
        this.#stormbreakerEnhanced++;
        break;
      case "stormbreaker.loop_broken":
        this.#stormbreakerLoopBroken++;
        break;
      case "stormbreaker.auto_retry":
        this.#stormbreakerAutoRetry++;
        break;
      case "edit.applied": {
        this.#editsApplied += event.editsApplied;
        for (const pass of event.passNames) {
          this.#editsAppliedByPass[pass] = (this.#editsAppliedByPass[pass] ?? 0) + 1;
        }
        // anchorUsed is counted from match.pass events (per edit, closest to
        // the source) — edit.applied carries the flag for the audit trail only.
        this.#editDurationSum += event.durationMs;
        this.#editDurationCount++;
        break;
      }
      case "overwrite_guard.blocked":
        this.#overwriteGuardBlocked++;
        break;
      case "write_guard.denied":
        this.#writeGuardDenied++;
        break;
      case "edit.partial": {
        this.#partialEdits++;
        break;
      }
      case "edit.autopatch":
        this.#autopatchCount++;
        break;
      case "edit.envelope": {
        this.#envelopesEmitted++;
        this.#totalCorruptionWarnings += event.corruptionWarnings.length;
        this.#totalCoherenceWarnings += event.coherenceWarnings.length;
        this.#totalPostWriteWarnings += event.postWriteWarnings.length;
        break;
      }
      case "path.advisory":
        this.#pathAdvisoryCount++;
        break;
      default: {
        // Exhaustive over the GuardEvent union — a new event kind that forgot
        // its counter case fails loudly instead of silently undercounting.
        throw new Error(
          `EditGuardTelemetry: unhandled event type ${(event as { type: string }).type}`,
        );
      }
    }
  }

  stats(): GuardStats {
    return {
      eventsRecorded: this.#eventsRecorded,
      editsAppliedByPass: { ...this.#editsAppliedByPass },
      repairRules: { ...this.#repairRules },
      unrepairableFingerprints: { ...this.#unrepairableFingerprints },
      preflightNormalized: this.#preflightNormalized,
      preflightBlocked: this.#preflightBlocked,
      staleReadBlocked: this.#staleReadBlocked,
      staleReadSelfHealed: this.#staleReadSelfHealed,
      stormbreakerEnhanced: this.#stormbreakerEnhanced,
      stormbreakerLoopBroken: this.#stormbreakerLoopBroken,
      stormbreakerAutoRetry: this.#stormbreakerAutoRetry,
      editsApplied: this.#editsApplied,
      anchorUsed: this.#anchorUsed,
      anchorNotFound: this.#anchorNotFound,
      anchorRedundantDropped: this.#anchorRedundantDropped,
      alreadyApplied: this.#alreadyApplied,
      anchorAmbiguous: this.#anchorAmbiguous,
      autoExpand: this.#autoExpand,
      meanEditDurationMs:
        this.#editDurationCount > 0
          ? Math.round((this.#editDurationSum / this.#editDurationCount) * 10) / 10
          : 0,
      meanClosestSimilarity:
        this.#closestCandidateCount > 0
          ? Math.round((this.#closestSimilaritySum / this.#closestCandidateCount) * 1000) / 1000
          : 0,
      closestCandidateCount: this.#closestCandidateCount,
      overwriteGuardBlocked: this.#overwriteGuardBlocked,
      writeGuardDenied: this.#writeGuardDenied,
      partialEdits: this.#partialEdits,
      autopatchCount: this.#autopatchCount,
      envelopesEmitted: this.#envelopesEmitted,
      totalCorruptionWarnings: this.#totalCorruptionWarnings,
      totalCoherenceWarnings: this.#totalCoherenceWarnings,
      totalPostWriteWarnings: this.#totalPostWriteWarnings,
      pathAdvisoryCount: this.#pathAdvisoryCount,
    };
  }

  /**
   * Return the buffered events (bounded ring, oldest dropped) and clear the
   * buffer. Counters persist — drain is for the session audit trail, not a
   * stats reset. Production code now uses flushNow() for session-start
   * recovery; drain is retained for tests and as the ring-buffer window.
   */
  drain(): GuardEvent[] {
    const drained = [...this.#events];
    this.#events.length = 0;
    return drained;
  }

  /**
   * Drain #pending and hand the batch to the flush handler (once, if
   * non-empty). Returns the batch. Handler errors are isolated: the batch
   * stays in #pending so the next checkpoint retries it — a transient
   * session-log failure must not silently drop up to PENDING_MAX events.
   */
  flushNow(): GuardEvent[] {
    const batch = this.#pending;
    if (batch.length === 0 || !this.#flushHandler) {
      this.#pending = [];
      return [];
    }
    try {
      this.#flushHandler(batch);
    } catch {
      // Keep #pending intact for the next checkpoint. record() counters
      // were already updated, so /edit-guard stays accurate.
      return batch;
    }
    this.#pending = [];
    return batch;
  }

  /** True when no events have ever been recorded. */
  get isEmpty(): boolean {
    return this.#eventsRecorded === 0;
  }

  /** Number of events buffered for the next checkpoint flush. */
  get pendingCount(): number {
    return this.#pending.length;
  }

  // ── Envelope support ──────────────────────────────────────────────────

  /**
   * Start tracking an edit call. Called by the edit tool before executeFile.
   * Returns a token the caller must hand back to endEdit/clearEditContext —
   * contexts are keyed, so an overlapping or retried call can neither
   * attribute its envelope to another call nor drop another call's context.
   */
  beginEdit(path: string, editIndex: number): number {
    const token = ++this.#nextEditToken;
    this.#editContexts.set(token, {
      path,
      editIndex,
      startTime: Date.now(),
      repairRulesSnapshot: { ...this.#repairRules },
    });
    return token;
  }

  /**
   * End tracking and build an envelope from collected telemetry. The token
   * identifies WHICH beginEdit this ends; unknown/stale tokens return null
   * instead of emitting a mis-attributed envelope.
   */
  endEdit(options: {
    token: number;
    editsApplied?: number;
    passNames?: string[];
    anchorUsed?: boolean;
    corruptionWarnings?: string[];
    coherenceWarnings?: string[];
    postWriteWarnings?: string[];
    semanticWarnings?: string[];
    closestCandidate?: { similarity: number; lineRange?: { start: number; end: number } };
    anchorIssues?: Array<{
      type: "not_found" | "ambiguous";
      anchorLen: number;
      occurrences?: number;
    }>;
    isPartial?: boolean;
    appliedCount?: number;
    failedCount?: number;
    repairNotes?: string[];
  }): EditGuardEnvelope | null {
    const context = this.#editContexts.get(options.token);
    if (!context) return null;
    this.#editContexts.delete(options.token);
    const { path, editIndex, startTime } = context;
    const durationMs = Date.now() - startTime;

    const failedCount = options.failedCount ?? 0;
    const applied = options.editsApplied ?? 0;
    const envelope: EditGuardEnvelope = {
      type: "edit.envelope",
      timestamp: Date.now(),
      path,
      editIndex,
      outcome: options.isPartial
        ? "partial"
        : applied === 0 || failedCount > 0
          ? "failed"
          : "applied",
      editsApplied: applied,
      passNames: options.passNames ?? [],
      anchorUsed: options.anchorUsed ?? false,
      durationMs,
      repairRules: Object.entries(this.#repairRules)
        .filter(([ruleId]) => {
          const before = context.repairRulesSnapshot[ruleId] ?? 0;
          return (this.#repairRules[ruleId] ?? 0) > before;
        })
        .map(([ruleId, count]) => ({
          ruleId,
          outcome: count > 0 ? "repaired" : "unrepairable",
        })),
      corruptionWarnings: options.corruptionWarnings ?? [],
      coherenceWarnings: options.coherenceWarnings ?? [],
      postWriteWarnings: options.postWriteWarnings ?? [],
      semanticWarnings: options.semanticWarnings ?? [],
      closestCandidate: options.closestCandidate,
      anchorIssues: options.anchorIssues,
      isPartial: options.isPartial,
      appliedCount: options.appliedCount,
      failedCount: options.failedCount,
      repairNotes: options.repairNotes,
    };

    return envelope;
  }

  /** Drop one in-progress edit context (abort/rollback), keyed by token. */
  clearEditContext(token: number): void {
    this.#editContexts.delete(token);
  }

  #editContexts = new Map<
    number,
    {
      path: string;
      editIndex: number;
      startTime: number;
      repairRulesSnapshot: Record<string, number>;
    }
  >();
  #nextEditToken = 0;
}

/**
 * Process-wide recorder. Hooks and the extension flush handler import this
 * singleton and call record(); events accumulate in #pending and extension.ts
 * flushes them as one batched audit entry per lifecycle checkpoint via
 * setFlushHandler. Tests use fresh EditGuardTelemetry instances for isolation.
 */
export const telemetry = new EditGuardTelemetry();
