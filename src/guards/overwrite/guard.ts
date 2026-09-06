/**
 * Overwrite guard — blocks blind overwrites of existing files.
 *
 * Per-session `Set<string>` of file paths that have been nudged. First write
 * to an existing non-empty file is blocked with a nudge message; the second
 * attempt (same file, same session) is allowed through. New file creation
 * and empty-file overwrites are always allowed.
 */

import { readFileSync, statSync } from "node:fs";

export interface StatLike {
  readonly size: number;
  readonly isFile: () => boolean;
}

export type StatFn = (path: string) => StatLike;
export type ReadFileFn = (path: string, encoding: "utf-8") => string;

export class OverwriteGuard {
  private nudged = new Set<string>();
  private readonly stat: StatFn;
  private readonly readFile: ReadFileFn;

  constructor(opts: { stat?: StatFn; readFile?: ReadFileFn } = {}) {
    this.stat = opts.stat ?? ((path: string) => statSync(path));
    this.readFile = opts.readFile ?? ((path: string) => readFileSync(path, "utf-8"));
  }

  /**
   * Check whether a write to `path` should be blocked.
   *
   * Returns a block reason string when the write must be blocked, or `null`
   * when the write is allowed.
   */
  checkWrite(path: string): string | null {
    if (this.nudged.has(path)) {
      return null;
    }

    try {
      const s = this.stat(path);
      if (!s.isFile()) {
        return null;
      }
      if (s.size === 0) {
        return null;
      }

      const content = this.readFile(path, "utf-8");
      const lines = content.split("\n").length;
      const reason = `🚫 Overwrite blocked — file exists and has content.

\`${path}\` already exists (${lines} lines). Use \`edit\` for targeted changes instead of \`write\`.

If you intentionally want to overwrite the entire file, call \`write\` again with the same path — this is a one-time block per file per session.`;

      this.nudged.add(path);
      return reason;
    } catch {
      return null;
    }
  }

  /** Clear all nudged state (session shutdown). */
  reset(): void {
    this.nudged.clear();
  }
}
