import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("../scripts/pre-commit.mjs", import.meta.url));

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd: dir,
    encoding: "utf8",
  });
}

/** Fresh temp repo with f.txt committed; returns dir. */
function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "hook-test-"));
  git(dir, "init", "-q");
  writeFileSync(join(dir, "f.txt"), "line1\nline2\nline3\nline4\n");
  git(dir, "add", "f.txt");
  git(dir, "commit", "-qm", "base");
  return dir;
}

/** Change two disjoint lines; stage only the first hunk via apply --cached. */
function stageFirstHunkOnly(dir: string): void {
  writeFileSync(join(dir, "f.txt"), "LINE1\nline2\nline3\nLINE4\n");
  const patch = ["--- a/f.txt", "+++ b/f.txt", "@@ -1 +1 @@", "-line1", "+LINE1", ""].join("\n");
  execFileSync("git", ["apply", "--cached", "--unidiff-zero", "-"], {
    cwd: dir,
    input: patch,
  });
}

/** Stub fixer: appends a marker to $TOUCH_FILE when TOUCH=1. Returns path. */
function stubFixer(dir: string): string {
  const p = join(dir, "stub-fixer.sh");
  writeFileSync(p, '#!/bin/sh\nif [ "$TOUCH" = "1" ]; then echo "# fixed" >> "$TOUCH_FILE"; fi\n');
  chmodSync(p, 0o755);
  return p;
}

/** Run the hook; returns exit status (0 = commit may proceed). */
function runHook(dir: string, stub: string, touch: boolean): number {
  try {
    execFileSync("node", [HOOK], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        EDIT_GUARD_LINT_STAGED: stub,
        TOUCH: touch ? "1" : "0",
        TOUCH_FILE: join(dir, "f.txt"),
      },
    });
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? 99;
  }
}

function stagedDiff(dir: string): string {
  return execFileSync("git", ["diff", "--cached", "--", "f.txt"], { cwd: dir, encoding: "utf8" });
}

describe("pre-commit hook partial-staging safety", () => {
  beforeAll(() => {
    execFileSync("git", ["--version"]);
  });

  it("aborts when the fixer touches a partially-staged file (no hunk leak)", () => {
    const dir = initRepo();
    const stub = stubFixer(dir);
    stageFirstHunkOnly(dir);

    const status = runHook(dir, stub, true);

    expect(status).toBe(1);
    const staged = stagedDiff(dir);
    expect(staged).toContain("+LINE1");
    expect(staged).not.toContain("+LINE4");
    expect(staged).not.toContain("# fixed");
  });

  it("restages fixer output for fully-staged files", () => {
    const dir = initRepo();
    const stub = stubFixer(dir);
    writeFileSync(join(dir, "f.txt"), "LINE1\nline2\nline3\nLINE4\n");
    git(dir, "add", "f.txt");

    const status = runHook(dir, stub, true);

    expect(status).toBe(0);
    const staged = stagedDiff(dir);
    expect(staged).toContain("+LINE1");
    expect(staged).toContain("+LINE4");
    expect(staged).toContain("# fixed");
  });

  it("leaves untouched partially-staged files alone and proceeds", () => {
    const dir = initRepo();
    const stub = stubFixer(dir);
    stageFirstHunkOnly(dir);

    const status = runHook(dir, stub, false);

    expect(status).toBe(0);
    const staged = stagedDiff(dir);
    expect(staged).toContain("+LINE1");
    expect(staged).not.toContain("+LINE4");
  });
});
