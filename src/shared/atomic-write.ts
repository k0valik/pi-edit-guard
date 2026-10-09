/**
 * Shared Windows rename lock-retry policy for atomic tmp-file + rename writes.
 *
 * Windows maps fs.renameSync to MoveFileEx with MOVEFILE_REPLACE_EXISTING,
 * which needs DELETE access on the destination. A process that holds the
 * destination open without FILE_SHARE_DELETE — a script interpreter that just
 * read the file, an antivirus scan, an editor — makes the rename fail with
 * EPERM, EACCES or EBUSY, while a direct write to the same path still succeeds
 * because it only needs write access. Those locks normally clear within a few
 * hundred milliseconds, so retry with a short backoff.
 *
 * Two consumers, two shapes:
 * - The undo store (src/history/store.ts) calls renameWithRetrySync: it is
 *   fully synchronous, so the backoff sleeps with a bounded Atomics.wait, and
 *   it has NO direct-write fallback — a failed compaction must never trade
 *   the store's crash-safety property (atomic rename) for availability.
 * - The edit pipeline (src/edit/pipeline/execute.ts) keeps its own async
 *   setTimeout wrapper with a direct-write fallback; it imports only the
 *   constants and the classifier. Adopting the sync core there would block
 *   the edit path's event loop up to 750 ms.
 */

/** Backoff schedule between rename attempts: 50/100/200/400 ms (750 ms total). */
export const RENAME_RETRY_DELAYS_MS: readonly number[] = [50, 100, 200, 400];

/** errno codes that clear by waiting: a holder without FILE_SHARE_DELETE. */
const TRANSIENT_LOCK_CODES: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * Whether an fs error is a transient Windows rename lock (EPERM/EACCES/EBUSY).
 * ENOENT, EISDIR and EXDEV cannot clear by waiting and are not transient.
 * Must be called on the RAW error — a sanitized wrapper carries no `.code`.
 */
export function isTransientLockError(err: unknown): boolean {
  const code = (err as { code?: string } | null | undefined)?.code;
  return typeof code === "string" && TRANSIENT_LOCK_CODES.has(code);
}

/**
 * Synchronously rename tmpPath to writePath, retrying transient Windows lock
 * errors through the RENAME_RETRY_DELAYS_MS backoff. Sleeps between attempts
 * with Atomics.wait (the 0-value slot is never written, so the wait always
 * times out — a pure blocking sleep). Throws the LAST transient error after
 * the full backoff; rethrows non-transient errors immediately, with no sleep.
 *
 * `rename` is injected so the core is unit-testable without fs mocking
 * (same idiom as ExecuteFileOptions). No writeFile/unlink parameters: temp
 * cleanup stays with the caller.
 */
export function renameWithRetrySync(
  rename: (from: string, to: string) => void,
  tmpPath: string,
  writePath: string,
): void {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RENAME_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) sleepSync(RENAME_RETRY_DELAYS_MS[attempt - 1]);
    try {
      rename(tmpPath, writePath);
      return;
    } catch (err) {
      if (!isTransientLockError(err)) throw err;
      lastError = err;
    }
  }
  throw lastError;
}

/** Blocking sleep for synchronous callers; Atomics.wait returns "timed-out" after ms. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
