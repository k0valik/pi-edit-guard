import { describe, it, expect, vi } from "vitest";
import {
  RENAME_RETRY_DELAYS_MS,
  isTransientLockError,
  renameWithRetrySync,
} from "../src/shared/atomic-write.js";

function lockError(code: string): Error {
  return Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
}

describe("renameWithRetrySync", () => {
  it("rethrows a non-transient error on the first attempt with no sleep", () => {
    const rename = vi.fn(() => {
      throw lockError("EISDIR");
    });

    expect(() => renameWithRetrySync(rename, "a.tmp", "a")).toThrowError(/EISDIR/);
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it("throws the last transient error after the full backoff", () => {
    const last = lockError("EBUSY");
    let calls = 0;
    const rename = vi.fn(() => {
      calls += 1;
      throw calls === RENAME_RETRY_DELAYS_MS.length + 1 ? last : lockError("EPERM");
    });

    let thrown: unknown;
    try {
      renameWithRetrySync(rename, "a.tmp", "a");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(last);
    expect(calls).toBe(RENAME_RETRY_DELAYS_MS.length + 1);
  });

  it("recovers when the lock clears mid-backoff", () => {
    let calls = 0;
    const rename = vi.fn(() => {
      calls += 1;
      if (calls <= 2) throw lockError("EPERM");
    });

    expect(() => renameWithRetrySync(rename, "a.tmp", "a")).not.toThrow();
    expect(calls).toBe(3);
  });
});

describe("isTransientLockError", () => {
  it("classifies EPERM, EACCES and EBUSY as transient", () => {
    expect(isTransientLockError(lockError("EPERM"))).toBe(true);
    expect(isTransientLockError(lockError("EACCES"))).toBe(true);
    expect(isTransientLockError(lockError("EBUSY"))).toBe(true);
  });

  it("classifies non-transient and malformed errors as not transient", () => {
    expect(isTransientLockError(lockError("ENOENT"))).toBe(false);
    expect(isTransientLockError(lockError("EISDIR"))).toBe(false);
    expect(isTransientLockError(lockError("EXDEV"))).toBe(false);
    expect(isTransientLockError(new Error("no code"))).toBe(false);
    expect(isTransientLockError(undefined)).toBe(false);
    expect(isTransientLockError("EPERM")).toBe(false);
  });
});
