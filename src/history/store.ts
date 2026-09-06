/**
 * JSONL-backed undo dump store — single-level per-file undo via append-only log.
 *
 * Format: NDJSON, one line per `{"path", "record"}`; deletions append a
 * tombstone (`"record": null`). Last line for a path wins (single-level
 * per-file undo — a deeper history would need a different layout). Parallel-safe:
 * puts/deletes are single O_APPEND writes, so concurrent sessions never
 * clobber each other's bytes and no file locking is required.
 *
 * Lifecycle: records survive sessions by design — there is no shutdown
 * cleanup; the store is the cross-session memory. Growth is bounded by FIFO
 * eviction at `maxBytes` (oldest-updated first, triggered only on put/delete —
 * reads never evict). Re-parsing cost stays proportional to the configured
 * budget, so the budget also bounds read latency.
 *
 * Resilience / why stateless:
 * - Malformed/torn lines (crash mid-write) are skipped line-by-line, never
 *   fatal — the log tolerates a torn tail and the next append prepends a
 *   newline separator if needed (see appendLine).
 * - Every operation re-reads the file from disk (stateless) instead of
 *   trusting an in-memory cache. Compaction (eviction/rewrite) therefore
 *   works from the current on-disk state and cannot drop records appended by
 *   a concurrent session after this instance last looked. Caching would
 *   re-introduce the lost-update race that the append-only design was chosen
 *   to avoid.
 *
 * Pure core — no pi imports (node:fs/path/os).
 */

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { getPiAgentDir } from "../../packages/pi-base/src/paths.js";

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
 * disk (stateless); appends are single O_APPEND writes.
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
   * Read the dump from disk and fold it into last-line-per-path winners.
   * Deliberately stateless: compaction below always works from the current
   * on-disk state, so records appended by concurrent sessions (other pi
   * processes share the same store file) are never dropped by a stale
   * in-memory view.
   */
  function readAll(): Map<string, UndoRecord> {
    const entries = new Map<string, UndoRecord>();

    if (!existsSync(storePath)) {
      return entries;
    }

    let raw: string;
    try {
      raw = readFileSync(storePath, "utf-8");
    } catch (error) {
      // Unreadable store — serve an empty view instead of failing the session.
      console.error("Failed to read undo store:", sanitizeError(error));
      return entries;
    }

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
   * Full rewrite from a freshly-read view (readAll already folded the dump
   * to last-line-per-path winners, tombstones applied). Only FIFO eviction
   * and clear() rewrite — puts and deletes are pure appends — so the shared
   * rename target is touched rarely. Two processes renaming concurrently
   * remain last-writer-wins for the whole file (the known residual race;
   * fixing it needs real file locking, which is out of scope). The staging
   * file is unique per process so simultaneous compactions cannot clobber
   * each other's temp write; a hard kill mid-rewrite may leave one behind,
   * which is harmless.
   */
  function rewrite(entries: Map<string, UndoRecord>): void {
    ensureDir();
    const tmpPath = `${storePath}.${process.pid}.tmp`;
    let body = "";
    for (const [key, value] of entries.entries()) {
      body += serializeLine(key, value);
    }
    try {
      writeFileSync(tmpPath, body, "utf-8");
    } catch (writeErr) {
      const message = sanitizeError(writeErr);
      console.error("Failed to write undo store:", message);
      throw message;
    }
    try {
      renameSync(tmpPath, storePath);
    } catch (renameErr) {
      try {
        if (existsSync(tmpPath)) unlinkSync(tmpPath);
      } catch {
        // ignore cleanup errors
      }
      const message = sanitizeError(renameErr);
      console.error("Failed to write undo store:", message);
      throw message;
    }
  }

  /**
   * FIFO eviction: when the dump exceeds `maxBytes`, rewrite without the
   * oldest-updated records until it fits. At least the newest record is
   * always kept, even a pathological single record larger than the budget.
   */
  function evictOversize(): void {
    let size: number;
    try {
      size = statSync(storePath).size;
    } catch {
      return;
    }
    if (size <= maxBytes) return;

    // Re-read from disk (not a cached view) so records appended by concurrent
    // sessions participate in the FIFO ordering instead of being dropped.
    const sized = [...readAll().entries()].map(([key, record]) => ({
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

    const kept = new Map(sized.slice(keepFrom).map((entry) => [entry.key, entry.record]));
    rewrite(kept);
  }

  /**
   * Append one serialized record. O_APPEND semantics mean concurrent writers
   * never overwrite each other's bytes. fs.writeSync may short-write, so the
   * buffer is written in a loop until complete. If an existing torn tail
   * lacks a trailing newline (crashed write), a separator is prepended so
   * the tail and this record cannot glue into one unparsable line.
   */
  function appendLine(line: string): void {
    ensureDir();
    let fd: number | undefined;
    try {
      // "a+" (not "a"): the append-only tail check below needs read access;
      // writes still carry O_APPEND semantics.
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
    } catch (error) {
      const message = sanitizeError(error);
      console.error("Failed to append undo entry:", message);
      throw message;
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

  return {
    get(path: string): UndoRecord | undefined {
      return readAll().get(path);
    },

    put(path: string, record: UndoRecord): void {
      appendLine(serializeLine(path, record));
      try {
        evictOversize();
      } catch (error) {
        // Eviction is best-effort hygiene; the append itself succeeded.
        console.warn("Undo store eviction failed:", sanitizeError(error));
      }
    },

    delete(path: string): void {
      // Append-only tombstone instead of a rewrite: deletes stay parallel-safe
      // exactly like puts (single O_APPEND write, last line wins). The
      // tombstone is written unconditionally — absence of a prior record
      // cannot be checked race-free anyway, and a stray tombstone is inert.
      appendLine(serializeTombstone(path));
      try {
        evictOversize();
      } catch (error) {
        // Eviction is best-effort hygiene; the tombstone itself succeeded.
        console.warn("Undo store eviction failed:", sanitizeError(error));
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
        // Best-effort rollback on failure.
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
