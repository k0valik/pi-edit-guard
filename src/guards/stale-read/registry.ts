/**
 * ReadRegistry — stale-read detection (paper: FileTimeTracker + assert_fresh).
 *
 * Records when the agent last read a file (record()) and rejects edits when
 * the file's mtime is newer than that read plus the tolerance window.
 * Escalation ladder per drifted mtime: first contact → hard error, same
 * drift repeat → advisory (verbatim-safe edits downgrade even on first
 * contact). Self-heal via selfRefresh() after the agent's own write so
 * read→edit→edit never self-blocks. Clock/stat/readFile and baseDir are
 * injected so tests use fake time and the Pi adapter can re-anchor cwd.
 */

import { resolve } from "node:path";

import type { EditError } from "../../edit/model.js";
import { staleReadError } from "../../edit/errors.js";

export interface StatLike {
  mtimeMs: number;
}

export type StatFn = (path: string) => StatLike;
export type NowFn = () => number;
/** Reads current file content for verbatim-safety checks. */
export type ReadFileFn = (path: string) => string;

export const DEFAULT_TOLERANCE_MS = 50; // from the paper

export class ReadRegistry {
  private reads = new Map<string, number>();
  private edits = new Map<string, number>();
  /** Paths whose CURRENT drifted state we already reacted to. */
  private warned = new Set<string>();
  /** The drifted mtime we reacted to — a NEW mtime escalates again. */
  private driftMtime = new Map<string, number>();
  private toleranceMs: number;
  private readonly now: NowFn;
  private readonly stat: StatFn;
  private readonly readFile?: ReadFileFn;
  /** Anchor for relative paths — pi sessions may run with ctx.cwd != process.cwd(). */
  private baseDir: string;

  constructor(opts: {
    now?: NowFn;
    stat: StatFn;
    readFile?: ReadFileFn;
    toleranceMs?: number;
    baseDir?: string;
  }) {
    this.now = opts.now ?? Date.now;
    this.stat = opts.stat;
    this.readFile = opts.readFile;
    this.toleranceMs = opts.toleranceMs ?? DEFAULT_TOLERANCE_MS;
    this.baseDir = opts.baseDir ?? process.cwd();
  }

  /**
   * Re-anchor relative-path resolution (called from hooks when ctx.cwd is
   * available). Keys already recorded keep their absolute form.
   */
  setBaseDir(dir: string): void {
    this.baseDir = dir;
  }

  private normalize(path: string): string {
    return resolve(this.baseDir, path);
  }

  /** Update tolerance at runtime (called when config changes). */
  setToleranceMs(ms: number): void {
    this.toleranceMs = ms;
  }

  /** Record a read of `path` at the current time. */
  record(path: string): void {
    const key = this.normalize(path);
    this.reads.set(key, this.now());
    // Fresh known baseline: the escalation ladder restarts. Without this, a
    // single flag poisoned the path for the whole session and every future
    // genuine drift degraded to proceed-and-advisory (mined: commit.md,
    // 2026-08-18).
    this.warned.delete(key);
    this.driftMtime.delete(key);
  }

  /** Last recorded read time for `path` (ms epoch), or undefined. */
  lastRead(path: string): number | undefined {
    return this.reads.get(this.normalize(path));
  }

  /**
   * True if the file's mtime is not newer than the last recorded read
   * or our own last successful edit (+ tolerance). A file that was never
   * read is considered fresh (no data to judge staleness).
   */
  isFresh(path: string): boolean {
    const key = this.normalize(path);
    const readAt = this.reads.get(key);
    if (readAt === undefined) return true;
    const editAt = this.edits.get(key);
    const effectiveReadAt = editAt !== undefined ? Math.max(readAt, editAt) : readAt;
    // Stat the RESOLVED key: a raw relative path would stat against
    // process.cwd() and miss the file entirely when the session's cwd
    // differs — surfacing mtime -1 and silently disarming the guard.
    const mtime = this.stat(key).mtimeMs;
    return mtime <= effectiveReadAt + this.toleranceMs;
  }

  /**
   * Returns a stale-read EditError if the file changed since the last read,
   * else null.
   *
   * Escalation ladder, per DRIFTED STATE (not per session lifetime):
   *   - first contact with this drift → hard error (re-read guidance)
   *   - repeat contact with the SAME drift → advisory, edit proceeds
   *     (pushing agents to sed/cat workarounds helps nobody — mined 2026-08)
   *   - verbatim-safe edits (every oldText still present in current content,
   *     CRLF-normalized) downgrade to advisory on FIRST contact: the splice
   *     is provably applicable; the result diff covers verification.
   *
   * record()/selfRefresh() reset the ladder — a fresh known baseline means
   * the next genuine drift blocks again.
   */
  assertFresh(
    path: string,
    opts?: { oldTexts?: string[] },
  ): EditError | { kind: "stale-read-warning"; message: string } | null {
    const key = this.normalize(path);
    if (this.isFresh(path)) return null;

    const mtime = this.stat(key).mtimeMs;
    const verbatimSafe = this.isVerbatimSafe(key, opts?.oldTexts);
    const sameDrift = this.driftMtime.get(key) === mtime;

    if (!sameDrift && !verbatimSafe) {
      // New drifted state we have not reacted to yet — block once and
      // remember exactly which mtime we reacted to.
      this.warned.add(key);
      this.driftMtime.set(key, mtime);
      return staleReadError();
    }

    // Mark the generation as reacted-to so the tool layer's single
    // pre-execution getStaleWarning() sample surfaces the advisory exactly
    // once per drift event (a silent proceed would hide real drift).
    this.warned.add(key);
    this.driftMtime.set(key, mtime);
    return {
      kind: "stale-read-warning",
      message:
        "[stale-read advisory] The file may have changed since your last read. The edit will proceed, but verify the result.",
    };
  }

  /**
   * True when EVERY oldText is still present in the current file content
   * (compared CRLF-normalized in both directions). Without a readFile
   * injection the check cannot run — treated as NOT safe.
   */
  private isVerbatimSafe(key: string, oldTexts?: string[]): boolean {
    if (!oldTexts || oldTexts.length === 0) return false;
    if (!this.readFile) return false;
    let content: string;
    try {
      content = this.readFile(key);
    } catch {
      return false;
    }
    const normContent = content.replace(/\r\n/g, "\n");
    return oldTexts.every((t) => {
      if (typeof t !== "string" || t.length === 0) return false;
      const norm = t.replace(/\r\n/g, "\n");
      return normContent.includes(norm) || content.includes(t);
    });
  }

  /**
   * Advisory warning for the edit tool result, without changing state.
   *
   * Gated on verbatim-safety: when the caller's search texts are ALL still
   * present in current content, the splice is provably applicable and the
   * drift is elsewhere (formatter noise — the common case), so there is
   * nothing to verify beyond the result diff and no advisory surfaces.
   * The warning fires only when drift plausibly affects THIS edit
   * (a search text is missing, or safety is unknown: no oldTexts / no
   * readFile injection). The hard block in assertFresh() is untouched.
   */
  getStaleWarning(path: string, oldTexts?: string[]): string | null {
    const key = this.normalize(path);
    if (this.isFresh(path)) return null;
    if (!this.warned.has(key)) return null;
    if (this.isVerbatimSafe(key, oldTexts)) return null;
    return "[stale-read advisory] The file may have changed since your last read. The edit will proceed, but verify the result.";
  }

  /** Mark the file as freshly known (called after our own successful edit). */
  selfRefresh(path: string): void {
    const key = this.normalize(path);
    const now = this.now();
    this.edits.set(key, now);
    this.reads.set(key, now);
    // Fresh baseline — same reset semantics as record().
    this.warned.delete(key);
    this.driftMtime.delete(key);
  }

  /** Forget all records (extension reload / session reset). */
  reset(): void {
    this.reads.clear();
    this.edits.clear();
    this.warned.clear();
    this.driftMtime.clear();
  }
}
