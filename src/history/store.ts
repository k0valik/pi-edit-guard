/**
 * JSONL-backed undo dump store — single-level per-file undo via an on-disk log.
 *
 * Format: NDJSON, one line per `{"path", "record"}`; deletions append a
 * tombstone (`"record": null`). Last line for a path wins (single-level
 * per-file undo — a deeper history would need a different layout). Appends
 * are O_APPEND writes under the O_EXCL store lock (src/shared/file-lock.ts),
 * so concurrent appenders never clobber each other's bytes.
 *
 * Lifecycle: records survive sessions by design — there is no shutdown
 * cleanup; the store is the cross-session memory. Concurrent pi sessions
 * share one store file, which is why writes are coordinated by an O_EXCL
 * advisory lock (src/shared/file-lock.ts) rather than trusting O_APPEND
 * alone. Growth is bounded by FIFO eviction at `maxBytes` (oldest-updated
 * first, triggered only on put/delete — reads never evict). Re-parsing cost
 * stays proportional to the configured budget, so the budget also bounds
 * read latency.
 *
 * Resilience / why stateless:
 * - Malformed/torn lines (crash mid-write) are skipped line-by-line, never
 *   fatal — the log tolerates a torn tail and the next append prepends a
 *   newline separator if needed (see appendLine). This covers partial
 *   APPENDS at EOF only: a compaction that dies inside its truncate+write
 *   window leaves a valid prefix missing middle records (the documented
 *   residual; see evictOversize).
 * - Every operation re-reads the file from disk (stateless) instead of
 *   trusting an in-memory cache. Compaction re-reads and folds the full
 *   body inside the lock, so records written by concurrent sessions are
 *   never dropped by a stale view. Caching would re-introduce the
 *   lost-update race the lock exists to close.
 *
 * Pure core — no pi imports (node:fs/path/os/worker_threads).
 */

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import {
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { threadId } from "node:worker_threads";
import { getPiAgentDir } from "../../packages/pi-base/src/paths.js";
import { StolenLock, withFileLock } from "../shared/file-lock.js";

export interface UndoRecord {
  content: string; // LF-normalized, BOM-free pre-edit content
  bom: string; // "" or "\uFEFF"
  originalEnding: "\n" | "\r\n" | "\r";
  resultContent: string; // LF-normalized, BOM-free post-edit content
  /** BOM-stripped raw pre-edit content (preserves mixed line endings). */
  rawContent?: string;
  /** BOM-stripped raw post-edit content (preserves mixed line endings). */
  rawResult?: string;
  updatedAt: number; // epoch ms — also the FIFO eviction key
  encoding: "utf-8" | "latin1";
  /** Provenance: pi session id that produced the edited state. */
  sessionId?: string;
  /** Provenance: project cwd at edit time. */
  project?: string;
}

export interface UndoStoreOptions {
  /**
   * Byte budget for the dump file. When the file exceeds this after a put(),
   * oldest records (by updatedAt) are evicted until it fits. Only put()
   * evicts — reads and deletes never drop other entries.
   */
  maxBytes?: number;
}

export interface UndoStore {
  get(path: string): UndoRecord | undefined;
  put(path: string, record: UndoRecord): void;
  delete(path: string): void;
}

/** Default FIFO byte budget for the undo dump (5 MB). */
export const DEFAULT_MAX_BYTES = 5_000_000;

/** Lower bound for configured byte budgets; config surfaces clamp to this. */
export const MIN_MAX_BYTES = 65_536;

/** Upper bound for configured byte budgets; config surfaces clamp to this. */
export const MAX_LIMIT_BYTES = 50_000_000;

/**
 * Clamp a configured byte budget to supported bounds; invalid input falls
 * back to the default. Shared by the env-var and ConfigManager surfaces so
 * `EDIT_GUARD_UNDO_MAX_BYTES=0` cannot silently reduce undo to one record.
 */
export function clampMaxBytes(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MAX_BYTES;
  return Math.min(MAX_LIMIT_BYTES, Math.max(MIN_MAX_BYTES, Math.trunc(value)));
}

/**
 * Create a JSONL-backed undo store. The store path is configurable via
 * `PI_UNDO_STORE_PATH`; otherwise it lives in the pi agent data dir or
 * `~/.local/state/pi-better-toolcalls/`. Operations re-read the dump from
 * disk (stateless); appends are O_APPEND writes under the store lock, and
 * compaction truncates + rewrites in place under the same lock.
 */
function defaultStorePath(): string {
  const envPath = process.env.PI_UNDO_STORE_PATH;
  if (envPath) {
    return envPath;
  }
  try {
    const piAgentDir = getPiAgentDir();
    return join(piAgentDir, "pi-better-toolcalls-undo-store.jsonl");
  } catch {
    return join(homedir(), ".local", "state", "pi-better-toolcalls", "undo-store.jsonl");
  }
}

interface StoreLine {
  path: string;
  /** `null` marks deletion (tombstone); otherwise the stored snapshot. */
  record: UndoRecord | null;
}

function isValidRecord(value: unknown): value is UndoRecord {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as UndoRecord).content === "string" &&
    typeof (value as UndoRecord).bom === "string" &&
    ((value as UndoRecord).originalEnding === "\n" ||
      (value as UndoRecord).originalEnding === "\r\n" ||
      (value as UndoRecord).originalEnding === "\r") &&
    typeof (value as UndoRecord).resultContent === "string" &&
    typeof (value as UndoRecord).updatedAt === "number" &&
    ((value as UndoRecord).encoding === "utf-8" || (value as UndoRecord).encoding === "latin1")
  );
}

function serializeLine(path: string, record: UndoRecord): string {
  return JSON.stringify({ path, record } satisfies StoreLine) + "\n";
}

/** Tombstone line: marks the path deleted without rewriting the dump. */
function serializeTombstone(path: string): string {
  return JSON.stringify({ path, record: null } satisfies StoreLine) + "\n";
}

/**
 * Once-per-breakage eviction-warning dedup, keyed by store path. Module-level
 * because getStore() creates a fresh store instance per saveUndo call when
 * options are passed (the edit pipeline always passes them), so a
 * per-instance flag would never dedupe across edits. An entry means
 * "eviction is currently broken and the user has been told"; put()/delete()
 * clear it after a successful eviction, so the next breakage warns again.
 */
const evictionWarned = new Map<string, boolean>();

export function createUndoStore(path?: string, options?: UndoStoreOptions): UndoStore {
  const storePath = path ?? defaultStorePath();
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;

  function ensureDir(): void {
    const dir = dirname(storePath);
    try {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    } catch {
      // Best-effort; the fs operation below will surface real errors.
    }
  }

  function sanitizeError(error: unknown): unknown {
    return error instanceof Error
      ? new Error(error.message.replace(storePath, "<undo-store>"), { cause: error })
      : error;
  }

  /**
   * Fold a raw NDJSON body into last-line-per-path winners: a tombstone
   * deletes the path, a valid record sets it (last line wins), malformed
   * or torn lines are skipped and counted. Shared by the lock-free read
   * path and the under-lock compaction re-read.
   */
  function foldBody(raw: string): Map<string, UndoRecord> {
    const entries = new Map<string, UndoRecord>();

    let malformedLines = 0;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as StoreLine;
        if (parsed && typeof parsed.path === "string" && parsed.record === null) {
          // Tombstone: a later line may still re-put the path (last wins).
          entries.delete(parsed.path);
        } else if (parsed && typeof parsed.path === "string" && isValidRecord(parsed.record)) {
          entries.set(parsed.path, parsed.record);
        } else {
          malformedLines++;
        }
      } catch {
        malformedLines++;
      }
    }
    if (malformedLines > 0) {
      console.warn(
        `Skipped ${malformedLines} malformed line(s) in undo store (torn writes are tolerated).`,
      );
    }

    return entries;
  }

  /**
   * Read the dump from disk and fold it into last-line-per-path winners.
   * Deliberately stateless: compaction below always works from the current
   * on-disk state, so records appended by concurrent sessions (other pi
   * processes share the same store file) are never dropped by a stale
   * in-memory view.
   */
  function readAll(): Map<string, UndoRecord> {
    if (!existsSync(storePath)) {
      return new Map<string, UndoRecord>();
    }

    try {
      return foldBody(readFileSync(storePath, "utf-8"));
    } catch (error) {
      // Unreadable store — serve an empty view instead of failing the session.
      console.error("Failed to read undo store:", sanitizeError(error));
      return new Map<string, UndoRecord>();
    }
  }

  /**
   * Stage the serialized folded body to a tmp file unique per thread.
   * Staging runs UNDER the store lock, from the same under-lock re-read that
   * feeds the commit, so the tmp always holds the body we are about to write
   * (it is the salvage copy for the truncate→write crash window); the name
   * carries pid AND worker threadId because worker threads share a pid —
   * pid-only names would let one worker's removeTmp unlink another's staged
   * write. A staging failure is pre-truncate: the store is untouched.
   */
  function stageTmp(entries: Map<string, UndoRecord>): string {
    ensureDir();
    const tmpPath = `${storePath}.${process.pid}.${threadId}.tmp`;
    let body = "";
    for (const [key, value] of entries.entries()) {
      body += serializeLine(key, value);
    }
    try {
      writeFileSync(tmpPath, body, "utf-8");
    } catch (writeErr) {
      const message = sanitizeError(writeErr);
      (message as Error & { undoStoreStage?: string }).undoStoreStage = "tmp-write";
      throw message;
    }
    return tmpPath;
  }

  function removeTmp(tmpPath: string | undefined): void {
    try {
      if (tmpPath !== undefined && existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      // ignore cleanup errors
    }
  }

  /**
   * FIFO eviction: when the dump exceeds `maxBytes`, compact the store in
   * place down to the newest-updated suffix that fits. At least the newest
   * record always survives, even a pathological single record larger than
   * the budget.
   *
   * Protocol (lock-coordinated in-place compaction):
   * 1. Fast path: stat the store; at or under budget, return without taking
   *    the lock.
   * 2. Under the store lock: re-read the FULL body from disk and fold it
   *    (tombstone-aware, last line wins), stage the folded body to the tmp
   *    file, re-run the FIFO slice over the folded set, then truncate and
   *    write the budgeted body in place. No rename on the store path — the
   *    Windows EPERM class (MoveFileEx needing DELETE access on a file
   *    another holder keeps open without FILE_SHARE_DELETE) cannot recur.
   * 3. Release, then unlink the tmp.
   *
   * The under-lock full re-read is what makes this loss-free: every byte
   * that reaches the commit is derived from the state observed while the
   * lock is held, so no decision rests on a pre-lock snapshot. Nothing can
   * append while we hold the lock, and an intervening compactor's commit is
   * always folded in rather than merged against a stale view.
   *
   * Self-heal (FRD req 3/6): a commit failure BEFORE the truncate completed
   * (re-read, staging, the truncate call) leaves the store untouched — no
   * heal, plain eviction-failure path. A failure AT/AFTER the truncate
   * retries the commit: same lock token → re-truncate + re-write inside the
   * same hold (nothing else can land while we hold the lock, and the partial
   * body is a prefix of the committed body, so the retry is idempotent);
   * token stolen → release, re-acquire through the normal protocol, and
   * complete the commit only when the current store is still a byte-prefix
   * of the committed body — an intervening compaction rewrote it, the
   * on-disk fold is authoritative, and merging our stale body would
   * resurrect records they evicted or tombstoned (then the original failure
   * surfaces via warnEvictionFailure).
   *
   * The hold covers the whole re-read + fold + stage + slice + truncate +
   * write of the body (up to 5 MB): milliseconds to tens of milliseconds, so
   * it stays far under the lock staleness threshold. Appends block for that
   * hold — the cost of removing the stale-snapshot loss class.
   *
   * Residual risk (FRD req 8): a hard kill between the truncate and the
   * write completing leaves a truncated store whose dropped records exist
   * only in the orphaned tmp (~10–50 ms window for a 5 MB store, silently
   * losing records after the truncation point). This is strictly better
   * than the removed rename's failure mode — a loud, loss-free EPERM error
   * — but is silent, which is why it is documented here. The loss is
   * accepted: the tmp's pid suffix cannot discriminate a pre-truncate
   * (stale) tmp from a post-truncate (salvage) one, and the marker rename
   * needed to tell them apart would re-add the rename this design removes.
   */
  function evictOversize(): void {
    let size: number;
    try {
      size = statSync(storePath).size;
    } catch {
      return;
    }
    if (size <= maxBytes) return;

    let tmpPath: string | undefined;
    let committedBody: string | undefined;

    try {
      withFileLock(storePath, (handle) => {
        // Full re-read under the lock, strict about the read itself: serving
        // the swallowed-error empty view here would truncate the store to
        // nothing on a transient read failure. A read failure therefore
        // propagates as a pre-truncate failure — store untouched.
        const staged = foldBody(readFileSync(storePath, "utf-8"));
        tmpPath = stageTmp(staged);
        committedBody = serializeBody(sliceToBudget(staged));
        try {
          truncateAndWrite(committedBody);
        } catch (error) {
          const truncated = (error as { undoStoreTruncated?: boolean }).undoStoreTruncated === true;
          if (!truncated) {
            throw error; // pre-truncate: store untouched, nothing to heal
          }
          if (!handle.isCurrent()) {
            throw new StolenLock(`${storePath}.lock`);
          }
          // Same token, still ours: one idempotent in-hold retry.
          truncateAndWrite(committedBody);
        }
      });
      removeTmp(tmpPath);
    } catch (error) {
      removeTmp(tmpPath);
      if (error instanceof StolenLock && committedBody !== undefined) {
        let healed = false;
        const body = committedBody;
        try {
          withFileLock(storePath, () => {
            const current = readFileSync(storePath, "utf-8");
            if (body.startsWith(current)) {
              truncateAndWrite(body);
              healed = true;
            }
          });
        } catch {
          // re-acquire or re-write failed: surface the original failure
        }
        if (healed) {
          return;
        }
      }
      // Classify on the RAW error (sanitizeError drops custom properties),
      // then surface the sanitized form with the stage/size decoration
      // re-applied — the <undo-store> path redaction applies to lock
      // acquire-exhaustion and StolenLock messages alike.
      const raw = error as Error & { lockPath?: string; undoStoreStage?: string };
      const surfaced = sanitizeError(raw) as Error & {
        undoStoreStage?: string;
        undoStoreSize?: number;
        undoStoreMaxBytes?: number;
      };
      if (raw.lockPath && !(error instanceof StolenLock) && !raw.undoStoreStage) {
        surfaced.undoStoreStage = "lock-acquire";
      } else if (raw.undoStoreStage) {
        surfaced.undoStoreStage = raw.undoStoreStage;
      }
      surfaced.undoStoreSize = size;
      surfaced.undoStoreMaxBytes = maxBytes;
      throw surfaced;
    }
  }

  /** Serialize a folded/kept map to the newline-terminated NDJSON body. */
  function serializeBody(entries: Map<string, UndoRecord>): string {
    let body = "";
    for (const [key, value] of entries.entries()) {
      body += serializeLine(key, value);
    }
    return body;
  }

  /**
   * FIFO slice over the folded set: per-line byte cost, ascending updatedAt,
   * keep the newest suffix that fits; at least the newest record survives.
   * Byte accounting runs over the set the under-lock fold produced, so a
   * replace that shrinks a kept record is recomputed rather than patched
   * incrementally.
   */
  function sliceToBudget(entries: Map<string, UndoRecord>): Map<string, UndoRecord> {
    const sized = [...entries.entries()].map(([key, record]) => ({
      key,
      record,
      bytes: Buffer.byteLength(serializeLine(key, record), "utf-8"),
    }));
    sized.sort((a, b) => a.record.updatedAt - b.record.updatedAt);
    let total = sized.reduce((sum, entry) => sum + entry.bytes, 0);
    let keepFrom = 0;
    while (keepFrom < sized.length && total > maxBytes) {
      total -= sized[keepFrom].bytes;
      keepFrom++;
    }
    if (keepFrom >= sized.length) {
      keepFrom = sized.length - 1;
    }
    return new Map(sized.slice(keepFrom).map((entry) => [entry.key, entry.record]));
  }

  /**
   * Commit the body in place under the lock: open r+ (write access only —
   * no DELETE access, no rename), truncate to zero, write with the same
   * short-write loop as appendLine. The body is built entirely from
   * serializeLine (newline-terminated), so the store ends newline-terminated
   * and the next append's separator check finds 0x0a. The thrown error
   * carries undoStoreTruncated: true only when the truncate itself
   * succeeded — the self-heal decides heal-vs-no-heal on that flag.
   */
  function truncateAndWrite(body: string): void {
    const buffer = Buffer.from(body, "utf-8");
    let fd: number | undefined;
    let truncated = false;
    try {
      fd = openSync(storePath, "r+");
      ftruncateSync(fd, 0);
      truncated = true;
      let offset = 0;
      while (offset < buffer.length) {
        const written = writeSync(fd, buffer, offset, buffer.length - offset);
        if (written <= 0) {
          throw new Error(`short write to undo store (${offset}/${buffer.length} bytes)`);
        }
        offset += written;
      }
    } catch (error) {
      const message = sanitizeError(error);
      const tagged = message as Error & {
        undoStoreStage?: string;
        undoStoreTruncated?: boolean;
      };
      tagged.undoStoreStage = "truncate-write";
      tagged.undoStoreTruncated = truncated;
      throw tagged;
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // ignore cleanup errors
        }
      }
    }
  }

  /**
   * Single deduped eviction-failure warn site for the put()/delete() catches.
   * Stage-aware: a tmp-write (staging) failure leads with the write-failure
   * line — a temp-write problem is not an eviction failure; lock-acquire,
   * under-lock re-read, and truncate-write failures lead with the
   * size-vs-budget eviction line (the append succeeded; only hygiene failed).
   * The rename stage died with the rename path.
   */
  function warnEvictionFailure(error: unknown): void {
    if (evictionWarned.get(storePath)) return;
    evictionWarned.set(storePath, true);
    const err = error as Error & {
      undoStoreStage?: string;
      undoStoreSize?: number;
      undoStoreMaxBytes?: number;
    };
    const detail = err instanceof Error ? err.message : String(err);
    if (err.undoStoreStage === "tmp-write") {
      console.warn(
        `Undo store compaction write failed (eviction skipped; further failures are silent until the next successful eviction): ${detail}`,
      );
    } else {
      console.warn(
        `Undo store eviction failed: undo store is ${err.undoStoreSize ?? "unknown"} bytes, over the ${err.undoStoreMaxBytes ?? "unknown"}-byte budget; further eviction failures are silent until the next successful eviction. Error: ${detail}`,
      );
    }
  }

  /**
   * Append one serialized record under the store lock. O_APPEND semantics
   * mean concurrent appenders never overwrite each other's bytes; the lock
   * additionally serializes appends against compaction's rewrite window (a
   * compactor must not truncate between the tail check and this write — the
   * record would land at an offset its staged body does not know about and
   * be destroyed). Appender-vs-appender double-newline is benign (blank
   * lines are skipped by readAll); appender-vs-compactor is the fatal
   * hazard. A lock-acquisition failure is an append failure: it propagates
   * here (persisted: false via saveUndo's catch), never through the
   * eviction-warning path.
   */
  function appendLine(line: string): void {
    ensureDir();
    try {
      withFileLock(storePath, () => {
        let fd: number | undefined;
        try {
          // "a+" (not "a"): the append-only tail check below needs read
          // access; writes still carry O_APPEND semantics.
          fd = openSync(storePath, "a+");
          let payload = line;
          const size = fstatSync(fd).size;
          if (size > 0) {
            const tail = Buffer.alloc(1);
            if (readSync(fd, tail, 0, 1, size - 1) === 1 && tail[0] !== 0x0a) {
              payload = "\n" + payload;
            }
          }
          const buffer = Buffer.from(payload, "utf-8");
          let offset = 0;
          while (offset < buffer.length) {
            const written = writeSync(fd, buffer, offset, buffer.length - offset);
            if (written <= 0) {
              throw new Error(`short write to undo store (${offset}/${buffer.length} bytes)`);
            }
            offset += written;
          }
        } finally {
          if (fd !== undefined) {
            try {
              closeSync(fd);
            } catch {
              // ignore cleanup errors
            }
          }
        }
      });
    } catch (error) {
      const message = sanitizeError(error);
      console.error("Failed to append undo entry:", message);
      throw message;
    }
  }

  return {
    get(path: string): UndoRecord | undefined {
      return readAll().get(path);
    },

    put(path: string, record: UndoRecord): void {
      appendLine(serializeLine(path, record));
      try {
        evictOversize();
        evictionWarned.delete(storePath);
      } catch (error) {
        // Eviction is best-effort hygiene; the append itself succeeded.
        warnEvictionFailure(error);
      }
    },

    delete(path: string): void {
      // Append-only tombstone instead of a rewrite: deletes stay parallel-safe
      // exactly like puts (single O_APPEND write under the store lock, last
      // line wins). The tombstone is written unconditionally — absence of a
      // prior record cannot be checked race-free anyway, and a stray
      // tombstone is inert.
      appendLine(serializeTombstone(path));
      try {
        evictOversize();
        evictionWarned.delete(storePath);
      } catch (error) {
        // Eviction is best-effort hygiene; the tombstone itself succeeded.
        warnEvictionFailure(error);
      }
    },
  };
}

// Module-level singleton (lazy-initialized on first use).
let _store: UndoStore | undefined;

function store(): UndoStore {
  if (!_store) {
    _store = createUndoStore();
  }
  return _store;
}

function getStore(storePath?: string, options?: UndoStoreOptions): UndoStore {
  if (storePath || options) {
    return createUndoStore(storePath, options);
  }
  return store();
}

/**
 * Save an undo entry, returning a restore function that puts the previous
 * entry back (or deletes if none). If the append fails, returns
 * `{ persisted: false }`.
 */
export async function saveUndo(
  path: string,
  entry: {
    content: string;
    bom: string;
    originalEnding: "\n" | "\r\n" | "\r";
    resultContent: string;
    rawContent?: string;
    rawResult?: string;
    encoding: "utf-8" | "latin1";
    sessionId?: string;
    project?: string;
  },
  storePath?: string,
  options?: UndoStoreOptions,
): Promise<{ persisted: boolean; restore: () => Promise<void> }> {
  let previous: UndoRecord | undefined;
  try {
    const s = getStore(storePath, options);
    previous = s.get(path);
    s.put(path, {
      content: entry.content,
      bom: entry.bom,
      originalEnding: entry.originalEnding,
      resultContent: entry.resultContent,
      rawContent: entry.rawContent,
      rawResult: entry.rawResult,
      updatedAt: Date.now(),
      encoding: entry.encoding,
      sessionId: entry.sessionId,
      project: entry.project,
    });
  } catch (error) {
    console.error("Failed to save undo entry:", error);
    return {
      persisted: false,
      restore: async () => {
        // Best-effort rollback on failure. No-op when `previous` is
        // undefined: reads are lock-free, and a compaction rewrite window
        // can transiently hide a record that exists. Deleting on an
        // undefined-but-racy `previous` would tombstone a live record —
        // the read race made destructive. In the non-race case there is
        // genuinely nothing to remove (no prior record + failed append),
        // so the no-op loses nothing. The success-path restore() keeps its
        // delete-when-undefined behavior (pinned: "restore() deletes entry
        // when there was no previous").
        if (previous === undefined) return;
        try {
          const s = getStore(storePath, options);
          s.put(path, previous);
        } catch (error) {
          console.error("Failed to restore previous undo entry:", error);
        }
      },
    };
  }

  return {
    persisted: true,
    restore: async () => {
      try {
        const s = getStore(storePath, options);
        if (previous !== undefined) s.put(path, previous);
        else s.delete(path);
      } catch (error) {
        console.error("Failed to restore previous undo entry:", error);
      }
    },
  };
}

/**
 * Load the undo entry for a path (reads the dump from disk, last line wins).
 * Validates the stored line-ending; auto-deletes corrupt entries.
 *
 * Reads are lock-free: during a concurrent compaction's truncate+write
 * window a read can transiently see a valid JSONL prefix missing middle
 * records — the user-visible effect is one wrong `E_UNDO_STALE`
 * (src/platform/tools/undo.ts), retryable and never destructive
 * (auto-delete fires only on a found, line-ending-invalid record; torn
 * lines fail JSON.parse and are skipped, so a truncated record cannot
 * trigger a delete of a valid entry).
 */
export function getUndo(path: string, storePath?: string): UndoRecord | undefined {
  const record = getStore(storePath).get(path);
  if (!record) return undefined;
  if (
    record.originalEnding !== "\n" &&
    record.originalEnding !== "\r\n" &&
    record.originalEnding !== "\r"
  ) {
    clearUndo(path, storePath);
    return undefined;
  }
  return record;
}

/**
 * Clear the undo entry for a path (best-effort: never throws).
 */
export function clearUndo(path: string, storePath?: string): void {
  try {
    getStore(storePath).delete(path);
  } catch (error) {
    console.error("Failed to clear undo entry:", error);
  }
}
