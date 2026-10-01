/**
 * Synchronous cross-process advisory lock built on O_EXCL file creation.
 *
 * Node's fs API exposes no LockFileEx/flock (as of Node 24), and this
 * codebase is sync end-to-end (Atomics.wait sleeps), so the lock is an
 * O_EXCL-created `<resource>.lock` file containing
 * `{"pid":number,"ts":number,"nonce":number}`. The nonce disambiguates
 * same-pid acquisitions within one millisecond (worker threads share a
 * pid):
 *
 * - Acquire: `openSync(lockPath, "wx")` maps to atomic CREATE_NEW on Windows
 *   and O_CREAT|O_EXCL on POSIX — exactly one create wins, and it needs
 *   DELETE access on nothing, so it cannot reproduce the rename-over-a-held-file
 *   EPERM class. It has its own Windows EPERM source: a rival's concurrent
 *   CREATE_NEW can fail with ERROR_ACCESS_DENIED (mapped to EPERM) while the
 *   winner still holds the just-created file open, where POSIX gives EEXIST.
 *   Both codes mean "this attempt lost", so tryAcquire contends on either.
 * - On a lost create the holder is evaluated: a malformed/unparsable payload is
 *   stale (a crash between create and payload write), a dead pid is stale
 *   (`process.kill(pid, 0)` → ESRCH), and an age over LOCK_STALE_MS is
 *   stale — the primary post-crash bound on Windows, where aggressive pid
 *   reuse defeats the ESRCH path. EPERM from the kill probe is treated as
 *   ALIVE (conservative): a false "dead" would steal a live holder's lock.
 * - A steal re-reads the payload immediately before unlinking to narrow the
 *   steal-a-refreshed-lock window, tolerates ENOENT (a rival stealer may
 *   have won), then retries O_EXCL. The mutual-exclusion guarantee is that
 *   exactly one VERIFIED payload wins: an acquisition is complete only when
 *   the lock file, read by path, carries the winner's `{pid, ts, nonce}` —
 *   post-write verification closes the create→write steal window.
 * - Release re-reads the payload and unlinks only when it still carries the
 *   holder's own token — a stolen lock belongs to the thief, not to us.
 *
 * The `withFileLock` wrapper guarantees release via try/finally, derives
 * `<resource>.lock` from the resource path, ensures the parent directory
 * exists before the first O_EXCL attempt, and rejects same-process
 * reentrancy (O_EXCL is not reentrant; nesting would spin to the acquire
 * ceiling instead of failing fast).
 *
 * Backoff, liveness, and the clock are injectable so tests never wait real
 * ~30 s TTLs (same idiom as renameWithRetrySync's injected `rename`).
 *
 * Mock constraint: built on openSync/readFileSync/unlinkSync/existsSync/
 * closeSync/writeSync/mkdirSync — never writeFileSync or renameSync, so
 * failure-injection toggles for compaction writes and renames cannot
 * conflate with lock behavior. writeSync is shared with the append path;
 * a payload-write failure leaves the empty lock file in place — the next
 * evaluator reads it as corrupt → stale → steals and unlinks it (no
 * by-path unlink, which could delete a rival's lock that stole the empty
 * file mid-write).
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { sleepSync } from "./atomic-write.js";

/**
 * Backoff between acquire attempts while the lock is held: 1575 ms ceiling.
 * Deliberately separate from RENAME_RETRY_DELAYS_MS so lock-wait retuning
 * cannot shift the edit path's 750 ms worst case.
 */
export const LOCK_RETRY_DELAYS_MS: readonly number[] = [25, 50, 100, 200, 400, 800];

/**
 * Lock age past which a holder is presumed dead. Millisecond-scale holds
 * make false steals vanishingly rare; on Windows this is the primary
 * post-crash bound because pid reuse defeats the ESRCH path.
 */
export const LOCK_STALE_MS = 30_000;

/** Shape written into the lock file at acquisition. */
interface LockPayload {
  pid: number;
  ts: number;
  /**
   * Per-acquisition nonce. Worker threads share a pid and Date.now() has
   * millisecond resolution, so {pid, ts} alone can collide across same-pid
   * acquisitions within one millisecond — the nonce makes the token unique
   * per acquisition.
   */
  nonce: number;
}

/**
 * Thrown by `fn` when the lock token changed mid-hold (the lock was stolen).
 * The wrapper releases in its finally and propagates; the caller re-acquires
 * through a fresh withFileLock and applies its own consistency check.
 */
export class StolenLock extends Error {
  readonly lockPath: string;
  constructor(lockPath: string) {
    super(`file lock stolen mid-hold: ${lockPath}`);
    this.name = "StolenLock";
    this.lockPath = lockPath;
  }
}

/**
 * Handle handed to `fn`: the acquisition token plus a mid-hold liveness
 * check. The self-heal protocol compares tokens through isCurrent().
 */
export interface FileLockHandle {
  /** Holder pid at acquisition (always the current process). */
  pid: number;
  /** Acquisition token: the `ts` written into the lock file. */
  token: number;
  /** Per-acquisition nonce disambiguating same-pid, same-millisecond tokens. */
  nonce: number;
  /** True while the lock file still carries this handle's `{pid, ts, nonce}`. */
  isCurrent(): boolean;
}

export interface FileLockOptions {
  /** Steal threshold for lock age; default LOCK_STALE_MS. */
  staleMs?: number;
  /** Backoff schedule between acquire attempts; default LOCK_RETRY_DELAYS_MS. */
  retryDelaysMs?: readonly number[];
  /** Clock seam (tests inject a controllable clock). */
  now?: () => number;
  /** Liveness seam standing in for the process.kill(pid, 0) probe (tests). */
  isPidAlive?: (pid: number) => boolean;
  /** Backoff seam standing in for sleepSync (tests inject a recorder). */
  sleep?: (ms: number) => void;
  /**
   * Create attempt for the lock file; `openSync(filePath, "wx")` by default.
   * Tests inject an open that throws EPERM to pin EPERM-as-contention off
   * Windows, where the live race cannot be reproduced.
   */
  open?: (filePath: string) => number;
}

/**
 * Locks currently held by this process, keyed by lock path. Module-level
 * because lock consumers create fresh instances per call (the undo store's
 * getStore() does), so per-instance state would never be shared. Doubles as
 * the reentrancy guard: O_EXCL is not reentrant, and a nested acquisition
 * from the same process must fail fast instead of spinning.
 */
const heldLocks = new Map<string, FileLockHandle>();

// Random per-isolate base so worker threads (separate isolates, shared pid)
// never collide; the sequence counter makes nonces unique within a process.
const nonceBase = (Math.random() * 0x7fffffff) | 0;
let acquisitionSeq = 0;

/** Read and validate the lock payload; anything malformed is undefined (stale). */
function readPayload(lockPath: string): LockPayload | undefined {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf-8")) as Partial<LockPayload>;
    if (
      parsed &&
      typeof parsed.pid === "number" &&
      typeof parsed.ts === "number" &&
      typeof parsed.nonce === "number"
    ) {
      return { pid: parsed.pid, ts: parsed.ts, nonce: parsed.nonce };
    }
    return undefined;
  } catch {
    // Unreadable or vanished mid-race: the caller treats undefined as stale.
    return undefined;
  }
}

/**
 * Default liveness probe. ESRCH means no such process (dead); anything else
 * — notably EPERM, which Windows surfaces for live holders — is
 * conservatively alive.
 */
function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string } | null | undefined)?.code !== "ESRCH";
  }
}

/**
 * One O_EXCL acquire attempt. Returns the acquisition ts on success,
 * undefined when the attempt did not win (EEXIST, Windows concurrent-create
 * EPERM, or the lock file was stolen between create and payload
 * verification). Any other fs error is a real failure (missing directory,
 * write failure) and surfaces raw — callers that sanitize must classify
 * before sanitizing, the same constraint rewrite() respects.
 *
 * An acquisition is complete only when the lock file, read BY PATH, carries
 * exactly this process's `{pid, ts, nonce}`: the create→write window is
 * covered by a post-write verification, so a rival that stole the
 * just-created (still empty) lock and re-acquired leaves us contended
 * rather than holding a ghost fd into an unlinked inode (POSIX) or deleting
 * the rival's lock during cleanup (Windows).
 */
function tryAcquire(
  lockPath: string,
  nonce: number,
  open: (filePath: string) => number,
): number | undefined {
  let fd: number;
  try {
    fd = open(lockPath);
  } catch (err) {
    const code = (err as { code?: string } | null | undefined)?.code;
    // EEXIST is the normal loss; EPERM is its Windows concurrent-create twin
    // (Phase 7's harness proved it). A genuine permission fault is not
    // swallowed: the bounded ceiling below still raises the loud
    // "file lock acquire failed after N attempts" error, which carries
    // lockPath for the store's lock-acquire stage tagging.
    if (code === "EEXIST" || code === "EPERM") {
      return undefined;
    }
    throw err;
  }
  const ts = Date.now();
  try {
    // Payload write via writeSync (never writeFileSync — see the mock
    // constraint in the module docstring).
    const buffer = Buffer.from(
      JSON.stringify({ pid: process.pid, ts, nonce } satisfies LockPayload),
      "utf-8",
    );
    let offset = 0;
    while (offset < buffer.length) {
      const written = writeSync(fd, buffer, offset, buffer.length - offset);
      if (written <= 0) {
        throw new Error(`short write to lock file (${offset}/${buffer.length} bytes)`);
      }
      offset += written;
    }
    // Post-write verification: the acquisition is ours only if the lock
    // file on disk still carries our payload. A mismatch means a rival
    // stole the just-created empty lock and re-acquired mid-write — we are
    // contended, not holder (the empty file we left behind is stolen and
    // unlinked by the normal corrupt-payload path).
    const verified = readPayload(lockPath);
    if (
      !verified ||
      verified.pid !== process.pid ||
      verified.ts !== ts ||
      verified.nonce !== nonce
    ) {
      return undefined;
    }
    return ts;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // ignore cleanup errors
    }
  }
}

/** Evaluate the current holder: true when the lock is stealable. */
function shouldSteal(
  observed: LockPayload | undefined,
  staleMs: number,
  now: () => number,
  isPidAlive: (pid: number) => boolean,
): boolean {
  if (!observed) return true; // corrupt/foreign/unparsable payload → stale
  if (now() - observed.ts > staleMs) return true;
  return !isPidAlive(observed.pid);
}

/**
 * Unlink a stealable lock. Re-reads the payload immediately before
 * unlinking: if it changed since evaluation (the holder refreshed, or a
 * rival stealer already replaced it), skip this round and re-evaluate.
 * Returns true when the unlink ran (the next O_EXCL attempt decides the
 * winner); false when the observed lock changed mid-steal.
 */
function steal(lockPath: string, observed: LockPayload | undefined): boolean {
  const current = readPayload(lockPath);
  if (observed === undefined) {
    // We evaluated a corrupt/missing payload. If the file now carries a
    // valid payload, it changed since evaluation — skip this round.
    if (current) return false;
  } else if (
    current &&
    (current.pid !== observed.pid || current.ts !== observed.ts || current.nonce !== observed.nonce)
  ) {
    return false; // refreshed since evaluation
  }
  try {
    unlinkSync(lockPath);
  } catch {
    // ENOENT: a rival stealer won the unlink; the O_EXCL retry still decides.
  }
  return true;
}

/**
 * Release a held lock. Unlinks only when the lock file still carries the
 * handle's token — if the lock was stolen mid-hold, it belongs to the thief
 * and unlinking it here would destroy the thief's lock.
 */
function release(lockPath: string, handle: FileLockHandle): void {
  const current = readPayload(lockPath);
  if (
    current &&
    (current.pid !== handle.pid || current.ts !== handle.token || current.nonce !== handle.nonce)
  ) {
    return;
  }
  try {
    unlinkSync(lockPath);
  } catch {
    // ENOENT: already gone (stolen and replaced, or manually removed).
  }
}

/**
 * Run `fn` while holding the advisory lock for `resourcePath`. The lock file
 * is `<resourcePath>.lock`; its parent directory is created best-effort
 * before the first O_EXCL attempt (a first-ever acquisition into a
 * nonexistent directory would otherwise fail with ENOENT on the directory).
 *
 * `fn` receives a handle whose isCurrent() detects a mid-hold steal (the
 * self-heal token check). Throwing StolenLock from `fn` releases the lock
 * (the thief's lock is left alone) and propagates; re-acquire through a
 * fresh withFileLock call.
 *
 * Contended acquisitions back off through retryDelaysMs and steal stale or
 * dead holders; after the schedule is exhausted the last state throws a
 * structured acquire failure (lockPath attached — classify before any
 * upstream sanitization).
 */
export function withFileLock<T>(
  resourcePath: string,
  fn: (handle: FileLockHandle) => T,
  options?: FileLockOptions,
): T {
  const lockPath = `${resourcePath}.lock`;
  if (heldLocks.has(lockPath)) {
    throw new Error(`file lock reentrancy: ${lockPath} is already held by this process`);
  }

  const dir = dirname(lockPath);
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // Best-effort; the O_EXCL attempt below surfaces real errors.
    }
  }

  const staleMs = options?.staleMs ?? LOCK_STALE_MS;
  const delays = options?.retryDelaysMs ?? LOCK_RETRY_DELAYS_MS;
  const sleep = options?.sleep ?? sleepSync;
  const now = options?.now ?? Date.now;
  const isPidAlive = options?.isPidAlive ?? defaultIsPidAlive;
  const open = options?.open ?? ((filePath: string) => openSync(filePath, "wx"));

  for (let attempt = 0; ; attempt++) {
    const nonce = nonceBase + ++acquisitionSeq;
    const ts = tryAcquire(lockPath, nonce, open);
    if (ts !== undefined) {
      const handle: FileLockHandle = {
        pid: process.pid,
        token: ts,
        nonce,
        isCurrent: () => {
          const current = readPayload(lockPath);
          return (
            !!current && current.pid === process.pid && current.ts === ts && current.nonce === nonce
          );
        },
      };
      heldLocks.set(lockPath, handle);
      try {
        return fn(handle);
      } finally {
        heldLocks.delete(lockPath);
        release(lockPath, handle);
      }
    }

    const observed = readPayload(lockPath);
    if (shouldSteal(observed, staleMs, now, isPidAlive)) {
      steal(lockPath, observed);
    }
    if (attempt >= delays.length) {
      const error = new Error(
        `file lock acquire failed after ${attempt + 1} attempts: ${lockPath}`,
      ) as Error & { lockPath: string };
      error.lockPath = lockPath;
      throw error;
    }
    sleep(delays[attempt]);
  }
}
