#!/usr/bin/env node

/**
 * Pre-commit hook — format and lint staged files only.
 *
 * Flow:
 *   1. Snapshot staged files, partially-staged files, and workdir hashes.
 *   2. Run lint-staged (oxfmt + oxlint --fix on staged files).
 *   3. Re-stage fully-staged files the fixer touched (safe: the workdir
 *      holds staged hunks + fixer changes only).
 *   4. Refuse to commit when the fixer touched a partially-staged file.
 *      `git add` on such a file would stage the user's unstaged hunks too
 *      (observed: an ARCHITECTURE.md hunk staged for a later commit leaked
 *      into an earlier one), while committing the pre-fix index version
 *      would land unformatted code. Aborting keeps both failure modes away;
 *      the user reviews (`git diff`), re-stages deliberately, and retries.
 *
 * Fast (~2s). The real gate (typecheck + test) runs at pre-push.
 *
 * Skip with: SKIP_SIMPLE_GIT_HOOKS=1 git commit
 * Override the fixer (tests): EDIT_GUARD_LINT_STAGED="<cmd> [args...]"
 */

import { execFileSync } from "node:child_process";

function run(command, args) {
  execFileSync(command, args, { stdio: "inherit" });
}

function gitFiles(args) {
  const output = execFileSync("git", args, { encoding: "utf8" });
  return output
    .split(/\r?\n/)
    .map((f) => f.trim())
    .filter(Boolean);
}

/** Files with staged changes. */
function stagedFiles() {
  return gitFiles(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]);
}

/** Files with unstaged workdir changes. */
function unstagedFiles() {
  return gitFiles(["diff", "--name-only"]);
}

/** Workdir content hash, or null when unhashable (deleted mid-run, etc.). */
function workdirHash(path) {
  try {
    return execFileSync("git", ["hash-object", "--", path], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function fixerCommand() {
  const override = process.env.EDIT_GUARD_LINT_STAGED;
  if (override && override.trim().length > 0) return override.trim().split(/\s+/);
  return ["pnpm", "exec", "lint-staged"];
}

const stagedBefore = stagedFiles();
const unstagedBefore = new Set(unstagedFiles());
const partialBefore = new Set(stagedBefore.filter((f) => unstagedBefore.has(f)));
const hashBefore = new Map(stagedBefore.map((f) => [f, workdirHash(f)]));

const [fixer, ...fixerArgs] = fixerCommand();
run(fixer, fixerArgs);

const stagedAfter = stagedFiles();
const touched = stagedBefore.filter((f) => workdirHash(f) !== hashBefore.get(f));

// Fully-staged files: re-stage the fixer output (staged hunks + fixes only).
const restageable = stagedAfter.filter((f) => stagedBefore.includes(f) && !partialBefore.has(f));
if (restageable.length > 0) {
  run("git", ["add", "--", ...restageable]);
}

// Partially-staged files the fixer rewrote: abort rather than leak hunks.
const partialTouched = touched.filter((f) => partialBefore.has(f));
if (partialTouched.length > 0) {
  console.error(
    `[pre-commit] refusing to commit: the formatter rewrote partially-staged file(s):\n` +
      partialTouched.map((f) => `  - ${f}`).join("\n") +
      `\nAuto-staging would leak your unstaged hunks into this commit. ` +
      `Review with \`git diff\`, stage what you want (\`git add -p\`), and retry.`,
  );
  process.exit(1);
}
