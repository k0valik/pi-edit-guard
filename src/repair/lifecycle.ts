export interface RepairFeedback {
  rules: string[];
  notes: string[];
  stages?: string[];
  profile?: string;
  model?: string;
  outcome?: "repaired" | "recovered";
  fingerprint?: string;
}

interface PendingFeedback extends RepairFeedback {
  key: string;
  timestamp: number;
}

/** TTL and capacity knobs for the repair-lifecycle queues. */
export interface RepairLifecycleOptions {
  ttlMs?: number;
  maxPending?: number;
  maxAssociated?: number;
  now?: () => number;
}

/**
 * Recursively normalize a value for stable serialization.
 *
 * Arrays and objects are deep-cloned with keys sorted alphabetically so
 * that semantically identical inputs produce identical strings regardless
 * of insertion order.
 */
function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizeJson(item)]),
    );
  }
  return value;
}

export function stableSerialize(value: unknown): string {
  try {
    return JSON.stringify(normalizeJson(value)) ?? String(value);
  } catch {
    return String(value);
  }
}

export class RepairLifecycle {
  readonly #ttlMs: number;
  readonly #maxPending: number;
  readonly #maxAssociated: number;
  readonly #now: () => number;
  readonly #pending: PendingFeedback[] = [];
  readonly #byCallId = new Map<string, { feedback: RepairFeedback; timestamp: number }>();

  constructor(options: RepairLifecycleOptions = {}) {
    this.#ttlMs = options.ttlMs ?? 5 * 60 * 1000;
    this.#maxPending = options.maxPending ?? 128;
    this.#maxAssociated = options.maxAssociated ?? 256;
    this.#now = options.now ?? Date.now;
  }

  enqueue(toolName: string, args: unknown, feedback: RepairFeedback): void {
    this.cleanup();
    this.#pending.push({
      ...feedback,
      rules: [...feedback.rules],
      notes: [...feedback.notes],
      key: `${toolName}\u0000${stableSerialize(args)}`,
      timestamp: this.#now(),
    });
    while (this.#pending.length > this.#maxPending) this.#pending.shift();
  }

  /**
   * Match a pending feedback entry by (toolName, serialized args) and
   * associate it with the tool call id so `take` can retrieve it later.
   * Returns the feedback (removed from the pending queue) or undefined.
   *
   * Misses are harmless: notes are lost, never attached to the wrong call.
   */
  correlate(toolName: string, args: unknown, toolCallId: string): RepairFeedback | undefined {
    this.cleanup();
    const key = `${toolName}\u0000${stableSerialize(args)}`;
    const index = this.#pending.findIndex((item) => item.key === key);
    if (index < 0) return undefined;
    const [pending] = this.#pending.splice(index, 1);
    if (!pending) return undefined;
    const feedback: RepairFeedback = {
      rules: pending.rules,
      notes: pending.notes,
      stages: pending.stages,
      profile: pending.profile,
      model: pending.model,
      outcome: pending.outcome,
      fingerprint: pending.fingerprint,
    };
    this.#setAssociated(toolCallId, feedback);
    return feedback;
  }

  /** Retrieve (and remove) the feedback associated with a tool call id. */
  take(toolCallId: string): RepairFeedback | undefined {
    this.cleanup();
    const feedback = this.#byCallId.get(toolCallId)?.feedback;
    this.#byCallId.delete(toolCallId);
    return feedback;
  }

  #setAssociated(toolCallId: string, feedback: RepairFeedback): void {
    this.cleanup();
    this.#byCallId.set(toolCallId, { feedback, timestamp: this.#now() });
    while (this.#byCallId.size > this.#maxAssociated) {
      const oldest = this.#byCallId.keys().next().value;
      if (oldest === undefined) break;
      this.#byCallId.delete(oldest);
    }
  }

  cleanup(): void {
    const cutoff = this.#now() - this.#ttlMs;
    while (this.#pending[0] && this.#pending[0].timestamp < cutoff) {
      this.#pending.shift();
    }
    for (const [toolCallId, item] of this.#byCallId) {
      if (item.timestamp < cutoff) this.#byCallId.delete(toolCallId);
    }
  }

  clear(): void {
    this.#pending.length = 0;
    this.#byCallId.clear();
  }

  get pendingCount(): number {
    return this.#pending.length;
  }
}

/**
 * Format repair notes as XML-tagged strings for model consumption.
 * Empty input returns an empty string.
 */
export function formatRepairNotes(notes: readonly string[]): string {
  return notes.map((note) => `<repair_note>${note}</repair_note>`).join("\n");
}
