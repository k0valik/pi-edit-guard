/**
 * Unit tests for the synchronous O_EXCL advisory lock (src/shared/file-lock.ts).
 *
 * Contention, staleness, and liveness paths run through the injected seams
 * (sleep/now/isPidAlive/retryDelaysMs/open) so no test waits a real ~30 s TTL
 * — same idiom as the injected-`rename` seam in tests/atomic-write.test.ts.
 * The default liveness probe's classification arms (ESRCH → dead, anything
 * else → alive) are exercised through the public API with a stubbed
 * process.kill, so the EPERM-as-alive decision is covered portably.
 *
 * The steal-race single-winner proof needs real concurrent O_EXCL creates,
 * which synchronous in-process code cannot interleave — the worker_threads
 * harness in Phase 7 (tests/undo-store-concurrency.test.ts) owns it.
 */

import { describe, it, expect, vi, afterAll } from "vitest";
import { existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOCK_RETRY_DELAYS_MS,
  LOCK_STALE_MS,
  StolenLock,
  withFileLock,
  type FileLockHandle,
} from "../src/shared/file-lock.js";

// Sandbox: all fixtures live under a temp dir, never the real global pi
// agent dir (same convention as tests/undo-store.test.ts:29-51; cleanup is
// afterAll-only — a beforeAll rmSync would delete the fresh sandbox).
const TEST_SANDBOX = mkdtempSync(join(tmpdir(), "pi-better-toolcalls-file-lock-"));

afterAll(() => {
  try {
    rmSync(TEST_SANDBOX, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function sandboxPath(file: string): string {
  return join(TEST_SANDBOX, file);
}

/** Pre-create a lock file for `resource` with the given payload. */
function seedLock(resource: string, payload: unknown): string {
  const lockPath = `${resource}.lock`;
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  writeFileSync(lockPath, body, "utf-8");
  return lockPath;
}

function readLockPayload(lockPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(lockPath, "utf-8")) as Record<string, unknown>;
}

describe("withFileLock happy path", () => {
  it("runs fn under the lock, exposes the token, and releases on return", () => {
    const resource = sandboxPath("happy");
    let handle: FileLockHandle | undefined;
    let sawLockDuringHold = false;

    const result = withFileLock(resource, (h) => {
      handle = h;
      sawLockDuringHold = existsSync(`${resource}.lock`);
      expect(h.pid).toBe(process.pid);
      expect(typeof h.token).toBe("number");
      expect(h.isCurrent()).toBe(true);
      return 42;
    });

    expect(result).toBe(42);
    expect(sawLockDuringHold).toBe(true);
    expect(existsSync(`${resource}.lock`)).toBe(false);
    // After release, isCurrent() reflects the vanished lock.
    expect(handle!.isCurrent()).toBe(false);
  });

  it("releases on fn failure and the path stays acquirable", () => {
    const resource = sandboxPath("throw-release");
    expect(() =>
      withFileLock(resource, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(existsSync(`${resource}.lock`)).toBe(false);
    withFileLock(resource, () => {}); // re-acquisition works
  });

  it("creates the parent directory on first acquisition", () => {
    const resource = join(TEST_SANDBOX, "nested", "dir", "store.jsonl");
    let sawLock = false;
    withFileLock(resource, () => {
      sawLock = existsSync(`${resource}.lock`);
    });
    expect(sawLock).toBe(true);
    expect(existsSync(`${resource}.lock`)).toBe(false);
  });
});

describe("contention and steal", () => {
  it("a live+fresh holder spins to the injected ceiling and throws a structured acquire failure", () => {
    const resource = sandboxPath("contended");
    seedLock(resource, { pid: process.pid, ts: Date.now(), nonce: 1 });

    const sleeps: number[] = [];
    let caught: unknown;
    try {
      withFileLock(resource, () => {}, {
        retryDelaysMs: [5, 10, 20],
        sleep: (ms) => sleeps.push(ms),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("file lock acquire failed");
    expect((caught as Error & { lockPath?: string }).lockPath).toBe(`${resource}.lock`);
    expect(sleeps).toEqual([5, 10, 20]);
    // The live holder's lock survives our failed attempts.
    expect(readLockPayload(`${resource}.lock`).pid).toBe(process.pid);
  });

  it("treats EPERM on create as contention (retries, then acquires)", () => {
    const resource = sandboxPath("eperm-create-contention");
    let calls = 0;
    const sleeps: number[] = [];
    withFileLock(resource, () => {}, {
      open: (p) => {
        calls++;
        if (calls <= 2) {
          throw Object.assign(new Error("EPERM: operation not permitted, open"), {
            code: "EPERM",
          });
        }
        return openSync(p, "wx");
      },
      sleep: (ms) => sleeps.push(ms),
    });
    // Two contended attempts, one win: the backoff prefix is consumed, and
    // the lock is released normally (never a leaked ghost fd).
    expect(calls).toBe(3);
    expect(sleeps).toEqual([25, 50]);
    expect(existsSync(`${resource}.lock`)).toBe(false);
  });

  it("a dead-pid holder is stolen and the new lock carries our payload", () => {
    const resource = sandboxPath("dead-pid");
    seedLock(resource, { pid: 999_999_999, ts: Date.now(), nonce: 1 });

    withFileLock(
      resource,
      () => {
        expect(readLockPayload(`${resource}.lock`).pid).toBe(process.pid);
      },
      { isPidAlive: () => false, sleep: () => {} },
    );
    expect(existsSync(`${resource}.lock`)).toBe(false);
  });

  it("a stale-ts holder with a LIVE pid is stolen (in-process leak recovery)", () => {
    const resource = sandboxPath("stale-ts");
    const nowMs = Date.now();
    seedLock(resource, { pid: process.pid, ts: nowMs - LOCK_STALE_MS - 1, nonce: 1 });

    withFileLock(
      resource,
      () => {
        // Stolen despite the live pid: staleness is the only in-process
        // recovery path (in-process instances share a pid).
        expect(readLockPayload(`${resource}.lock`).pid).toBe(process.pid);
      },
      { now: () => nowMs, sleep: () => {} },
    );
    expect(existsSync(`${resource}.lock`)).toBe(false);
  });

  it("a corrupt payload is treated as stale", () => {
    const resource = sandboxPath("corrupt");
    seedLock(resource, "GARBAGE{{{not json");

    withFileLock(
      resource,
      () => {
        expect(readLockPayload(`${resource}.lock`).pid).toBe(process.pid);
      },
      { sleep: () => {} },
    );
  });

  it("a foreign-shaped payload is treated as stale", () => {
    const resource = sandboxPath("foreign");
    seedLock(resource, { foo: "bar" });

    withFileLock(
      resource,
      () => {
        expect(readLockPayload(`${resource}.lock`).pid).toBe(process.pid);
      },
      { sleep: () => {} },
    );
  });
});

describe("default liveness probe classification", () => {
  it("treats EPERM from the probe as alive (no steal of a live holder)", () => {
    const resource = sandboxPath("eperm-alive");
    seedLock(resource, { pid: 424242, ts: Date.now(), nonce: 1 });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    });
    const sleeps: number[] = [];
    try {
      expect(() =>
        withFileLock(resource, () => {}, { sleep: (ms) => sleeps.push(ms) }),
      ).toThrowError(/file lock acquire failed/);
      // Never stolen: the seeded holder's payload survives every attempt.
      expect(readLockPayload(`${resource}.lock`).pid).toBe(424242);
      expect(sleeps).toEqual([...LOCK_RETRY_DELAYS_MS]);
    } finally {
      kill.mockRestore();
    }
  });

  it("treats ESRCH from the probe as dead (steal)", () => {
    const resource = sandboxPath("esrch-dead");
    seedLock(resource, { pid: 424242, ts: Date.now(), nonce: 1 });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("ESRCH: no such process"), { code: "ESRCH" });
    });
    try {
      withFileLock(
        resource,
        () => {
          expect(readLockPayload(`${resource}.lock`).pid).toBe(process.pid);
        },
        { sleep: () => {} },
      );
    } finally {
      kill.mockRestore();
    }
  });
});

describe("reentrancy and stolen-release discipline", () => {
  it("same-process reentrancy fails fast", () => {
    const resource = sandboxPath("reentrant");
    expect(() =>
      withFileLock(resource, () =>
        withFileLock(resource, () => {
          // unreachable
        }),
      ),
    ).toThrowError(/reentrancy/);
    // The outer finally released the lock despite the inner throw.
    expect(existsSync(`${resource}.lock`)).toBe(false);
  });

  it("a stolen lock is not unlinked by the former owner's release", () => {
    const resource = sandboxPath("stolen-release");
    const thiefPayload = JSON.stringify({ pid: process.pid, ts: Date.now(), nonce: 999 });

    expect(() =>
      withFileLock(resource, () => {
        // Simulate a mid-hold steal: the lock file now carries the thief's
        // token. Our release must leave it alone (token mismatch).
        writeFileSync(`${resource}.lock`, thiefPayload, "utf-8");
        throw new StolenLock(`${resource}.lock`);
      }),
    ).toThrow(StolenLock);

    expect(readFileSync(`${resource}.lock`, "utf-8")).toBe(thiefPayload);
  });
});
