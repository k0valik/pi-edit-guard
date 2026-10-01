import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  createUndoStore,
  saveUndo,
  getUndo,
  clearUndo,
  clampMaxBytes,
  DEFAULT_MAX_BYTES,
  MAX_LIMIT_BYTES,
  MIN_MAX_BYTES,
  type UndoRecord,
} from "../src/history/store.js";
import { join } from "node:path";

// Toggles to force fs failures for the undo store:
// - _forceWriteFailure scopes write failures to the compaction tmp write
//   ("rewrite"), the O_APPEND line write ("append"), or both ("all").
// - _forceTruncateFailure makes ftruncateSync fail with a code-carrying
//   error for its first `times` calls (Infinity: every call) — the
//   pre-truncate failure class: store untouched, no heal.
// - _forceCommitWriteFailure makes the COMMIT writeSync fail (only on the
//   fd that just passed through ftruncateSync — _truncatedFd, cleared on
//   close so fd recycling cannot mis-arm the lock-payload or append
//   writes) for its first `times` calls; stealLock replaces the lock file
//   with a dead-pid payload on the armed call, driving the StolenLock heal.
// - _forceLockAcquireFailure makes openSync("wx") of _armedLockPath throw
//   EEXIST from the fromCall-th attempt: fromCall 2 lets the append
//   window's acquire pass and exhausts the compaction window's.
// Reset all counters and flags when re-arming and in finally.
let _forceWriteFailure: false | "rewrite" | "append" | "all" = false;
let _forceTruncateFailure: false | { code: string; times: number } = false;
let _truncateCalls = 0;
let _forceCommitWriteFailure: false | { times: number; stealLock?: boolean } = false;
let _commitWriteCalls = 0;
let _truncatedFd: number | undefined;
let _forceLockAcquireFailure: false | { fromCall: number } = false;
let _lockOpenCalls = 0;
let _armedLockPath: string | undefined;

// Test sandbox: all fixtures live under a temp dir, never the real
// global pi agent dir.
const TEST_SANDBOX = mkdtempSync(join(tmpdir(), "pi-better-toolcalls-undo-store-"));

function sandboxPath(file: string): string {
  return join(TEST_SANDBOX, file);
}

beforeAll(() => {
  // Best-effort cleanup on process exit. Failures here do not fail the suite.
  try {
    rmSync(TEST_SANDBOX, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

afterAll(() => {
  try {
    rmSync(TEST_SANDBOX, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// Mock node:fs primitives to simulate store failures. vitest hoists
// vi.mock, so it's active before the store module loads. The commit arm is
// fd-scoped (see toggles) so it cannot mis-fire on lock-payload or append
// writes that recycle the truncated fd's number.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual("node:fs");
  return {
    ...actual,
    openSync: (...args: any[]) => {
      if (
        _forceLockAcquireFailure !== false &&
        typeof args[0] === "string" &&
        args[0] === _armedLockPath &&
        args[1] === "wx"
      ) {
        _lockOpenCalls += 1;
        if (_lockOpenCalls >= _forceLockAcquireFailure.fromCall) {
          throw Object.assign(new Error("EEXIST: file already exists, open"), {
            code: "EEXIST",
          });
        }
      }
      return (actual as any).openSync(...args);
    },
    closeSync: (...args: any[]) => {
      if (args[0] === _truncatedFd) {
        _truncatedFd = undefined; // the commit arm dies with its fd
      }
      return (actual as any).closeSync(...args);
    },
    writeFileSync: (...args: any[]) => {
      if (_forceWriteFailure === "rewrite" || _forceWriteFailure === "all") {
        throw new Error("EACCES: permission denied");
      }
      return (actual as any).writeFileSync(...args);
    },
    writeSync: (...args: any[]) => {
      if (_forceWriteFailure === "append" || _forceWriteFailure === "all") {
        throw new Error("EACCES: permission denied");
      }
      if (
        _forceCommitWriteFailure !== false &&
        _truncatedFd !== undefined &&
        args[0] === _truncatedFd &&
        _commitWriteCalls < _forceCommitWriteFailure.times
      ) {
        _commitWriteCalls += 1;
        if (_forceCommitWriteFailure.stealLock && _armedLockPath) {
          (actual as any).writeFileSync(
            _armedLockPath,
            JSON.stringify({ pid: 999_999_999, ts: Date.now(), nonce: 1 }),
            "utf-8",
          );
        }
        throw Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" });
      }
      return (actual as any).writeSync(...args);
    },
    ftruncateSync: (...args: any[]) => {
      if (_forceTruncateFailure !== false && _truncateCalls < _forceTruncateFailure.times) {
        _truncateCalls += 1;
        throw Object.assign(
          new Error(`${_forceTruncateFailure.code}: operation not permitted, truncate`),
          { code: _forceTruncateFailure.code },
        );
      }
      _truncatedFd = args[0] as number;
      return (actual as any).ftruncateSync(...args);
    },
  };
});

function makeRecord(overrides: Partial<UndoRecord> = {}): UndoRecord {
  return {
    content: "hello\nworld",
    bom: "",
    originalEnding: "\n",
    resultContent: "hello\nearth",
    updatedAt: 1000,
    encoding: "utf-8",
    ...overrides,
  };
}

/**
 * Exact on-disk byte cost of one stored line — the shape `serializeLine`
 * writes (`JSON.stringify({ path, record })` plus the newline). Lets a test
 * pin a budget at an exact boundary instead of estimating it.
 */
function lineBytes(path: string, record: UndoRecord): number {
  return Buffer.byteLength(JSON.stringify({ path, record }) + "\n", "utf-8");
}

describe("clampMaxBytes", () => {
  it("clamps out-of-range budgets to the supported bounds", () => {
    expect(clampMaxBytes(0)).toBe(MIN_MAX_BYTES);
    expect(clampMaxBytes(-5)).toBe(MIN_MAX_BYTES);
    expect(clampMaxBytes(1_000)).toBe(MIN_MAX_BYTES);
    expect(clampMaxBytes(Number.MAX_SAFE_INTEGER)).toBe(MAX_LIMIT_BYTES);
  });

  it("passes in-range budgets through and truncates fractions", () => {
    expect(clampMaxBytes(MIN_MAX_BYTES)).toBe(MIN_MAX_BYTES);
    expect(clampMaxBytes(MAX_LIMIT_BYTES)).toBe(MAX_LIMIT_BYTES);
    expect(clampMaxBytes(1_000_000.9)).toBe(1_000_000);
  });

  it("falls back to the default for invalid input", () => {
    expect(clampMaxBytes(undefined)).toBe(DEFAULT_MAX_BYTES);
    expect(clampMaxBytes(null)).toBe(DEFAULT_MAX_BYTES);
    expect(clampMaxBytes("1000")).toBe(DEFAULT_MAX_BYTES);
    expect(clampMaxBytes(Number.NaN)).toBe(DEFAULT_MAX_BYTES);
  });
});

describe("createUndoStore", () => {
  it("round-trips a single entry", () => {
    const storePath = sandboxPath("roundtrip.jsonl");
    const store = createUndoStore(storePath);

    store.put("/tmp/a.txt", makeRecord());
    expect(store.get("/tmp/a.txt")).toBeDefined();
    expect(store.get("/tmp/a.txt")!.content).toBe("hello\nworld");
  });

  it("last line wins for the same path (append-only dump)", () => {
    const storePath = sandboxPath("last-wins.jsonl");
    const store = createUndoStore(storePath);

    store.put("/tmp/a.txt", makeRecord({ content: "v1" }));
    store.put("/tmp/a.txt", makeRecord({ content: "v2" }));
    expect(store.get("/tmp/a.txt")!.content).toBe("v2");

    // Both lines remain in the file until compaction.
    const body = readFileSync(storePath, "utf-8");
    const lines = body.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(2);
  });

  it("delete appends a tombstone and fresh readers honor it", () => {
    const storePath = sandboxPath("delete.jsonl");
    const store = createUndoStore(storePath);

    store.put("/tmp/a.txt", makeRecord({ content: "v1" }));
    store.put("/tmp/a.txt", makeRecord({ content: "v2" }));
    store.delete("/tmp/a.txt");
    expect(store.get("/tmp/a.txt")).toBeUndefined();

    // Superseded lines stay on disk until the next rewrite (FIFO eviction or
    // clear) folds them away — deletes are pure appends.
    const body = readFileSync(storePath, "utf-8");
    expect(body).toContain('"content":"v1"');

    const fresh = createUndoStore(sandboxPath("delete.jsonl"));
    expect(fresh.get("/tmp/a.txt")).toBeUndefined();
  });

  it("a tombstone from another writer wins over earlier puts, and a later put resurrects", () => {
    const storePath = sandboxPath("tombstone-race.jsonl");

    const a = createUndoStore(storePath);
    a.put("/tmp/a.txt", makeRecord({ content: "a1" }));

    // Another session deletes the path via append-only tombstone.
    createUndoStore(storePath).delete("/tmp/a.txt");

    // A stale instance re-puts its old record afterwards — last line wins.
    a.put("/tmp/a.txt", makeRecord({ content: "stale-put" }));

    const fresh = createUndoStore(storePath);
    expect(fresh.get("/tmp/a.txt")!.content).toBe("stale-put");

    // Deleting again after the re-put hides it once more.
    fresh.delete("/tmp/a.txt");
    expect(createUndoStore(storePath).get("/tmp/a.txt")).toBeUndefined();
  });

  it("supports multiple independent paths", () => {
    const storePath = sandboxPath("multi.jsonl");
    const store = createUndoStore(storePath);

    store.put("/tmp/a.txt", makeRecord({ content: "a" }));
    store.put("/tmp/b.txt", makeRecord({ content: "b" }));
    expect(store.get("/tmp/a.txt")!.content).toBe("a");
    expect(store.get("/tmp/b.txt")!.content).toBe("b");
  });

  it("survives store close and reopen", () => {
    const storePath = sandboxPath("restart.jsonl");

    {
      const store = createUndoStore(storePath);
      store.put("/tmp/a.txt", makeRecord({ content: "persisted" }));
    }

    {
      const store = createUndoStore(storePath);
      expect(store.get("/tmp/a.txt")!.content).toBe("persisted");
    }
  });

  it("parallel instances appending do not clobber each other", () => {
    const storePath = sandboxPath("parallel.jsonl");

    const a = createUndoStore(storePath);
    const b = createUndoStore(storePath);
    a.put("/tmp/from-a.txt", makeRecord({ content: "a" }));
    b.put("/tmp/from-b.txt", makeRecord({ content: "b" }));

    // A fresh instance resolves last-line-per-path across both writers.
    const c = createUndoStore(storePath);
    expect(c.get("/tmp/from-a.txt")!.content).toBe("a");
    expect(c.get("/tmp/from-b.txt")!.content).toBe("b");
  });

  it("compaction via delete preserves records appended after this instance last read", () => {
    const storePath = sandboxPath("concurrent-delete.jsonl");

    const a = createUndoStore(storePath);
    a.put("/tmp/a.txt", makeRecord({ content: "a" }));

    // Another session appends its own record afterwards.
    const b = createUndoStore(storePath);
    b.put("/tmp/b.txt", makeRecord({ content: "b" }));

    // A compacts via delete — it must not drop b's record even though a's
    // in-memory view predates the append (stateless reads).
    a.delete("/tmp/a.txt");

    const fresh = createUndoStore(storePath);
    expect(fresh.get("/tmp/a.txt")).toBeUndefined();
    expect(fresh.get("/tmp/b.txt")!.content).toBe("b");
  });

  it("FIFO eviction does not drop another writer's newer records", () => {
    const storePath = sandboxPath("concurrent-evict.jsonl");

    const a = createUndoStore(storePath, { maxBytes: 600 });
    a.put("/tmp/old.txt", makeRecord({ updatedAt: 1000 }));

    // Another session appends a big, newer record (its own budget is the
    // default, so it does not evict on its side).
    const b = createUndoStore(storePath);
    b.put("/tmp/new.txt", makeRecord({ updatedAt: 9000, content: "x".repeat(500) }));

    // a puts an older record that pushes the file over a's budget and
    // triggers eviction — eviction must re-read from disk and keep the
    // newest-updated record regardless of which instance wrote it.
    a.put("/tmp/trigger.txt", makeRecord({ updatedAt: 500 }));

    const fresh = createUndoStore(storePath);
    expect(fresh.get("/tmp/new.txt")).toBeDefined();
    expect(fresh.get("/tmp/old.txt")).toBeUndefined();
    expect(fresh.get("/tmp/trigger.txt")).toBeUndefined();
  });

  it("compaction via eviction folds tombstones away without resurrecting deleted paths", () => {
    const storePath = sandboxPath("evict-tombstone.jsonl");

    const a = createUndoStore(storePath, { maxBytes: 600 });
    a.put("/tmp/kept.txt", makeRecord({ updatedAt: 9000, content: "x".repeat(400) }));
    a.put("/tmp/gone.txt", makeRecord({ updatedAt: 1000 }));
    a.delete("/tmp/gone.txt");

    // Push over budget so eviction rewrites from the folded view.
    a.put("/tmp/spam.txt", makeRecord({ updatedAt: 500, content: "y".repeat(200) }));

    const fresh = createUndoStore(storePath);
    expect(fresh.get("/tmp/kept.txt")).toBeDefined();
    expect(fresh.get("/tmp/gone.txt")).toBeUndefined();

    const body = readFileSync(storePath, "utf-8");
    expect(body).not.toContain("gone.txt"); // tombstone + superseded record gone
  });

  it("appending after a crash-torn tail without a trailing newline keeps records readable", () => {
    const storePath = sandboxPath("torn-tail.jsonl");
    const good = makeRecord({ content: "good" });
    writeFileSync(
      storePath,
      JSON.stringify({ path: "/tmp/intact.txt", record: good }) +
        '\n{"path":"/tmp/torn.tx","record":{"content":"cut',
      "utf-8",
    );

    const store = createUndoStore(storePath);
    store.put("/tmp/after.txt", makeRecord({ content: "after" }));

    const fresh = createUndoStore(storePath);
    expect(fresh.get("/tmp/intact.txt")).toBeDefined();
    expect(fresh.get("/tmp/after.txt")!.content).toBe("after");
  });

  it("skips malformed and torn lines instead of failing", () => {
    const storePath = sandboxPath("torn.jsonl");
    const good = makeRecord({ content: "good" });
    writeFileSync(
      storePath,
      (
        "GARBAGE{{{not json\n" +
        JSON.stringify({ path: "/tmp/good.txt", record: good }) +
        "\n" +
        '{"path":"/tmp/torn.tx","record":{"content":"cut'
      ) // no newline, invalid
        .trim() + "\n",
      "utf-8",
    );

    const store = createUndoStore(storePath);
    expect(store.get("/tmp/good.txt")!.content).toBe("good");

    // Store remains writable after tolerant load.
    store.put("/tmp/after.txt", makeRecord({ content: "after" }));
    expect(createUndoStore(storePath).get("/tmp/after.txt")).toBeDefined();
  });

  it("FIFO-evicts oldest-updated records when over maxBytes", () => {
    const storePath = sandboxPath("fifo.jsonl");
    const store = createUndoStore(storePath, { maxBytes: 700 });

    for (let i = 1; i <= 6; i++) {
      store.put(`/tmp/f${i}.txt`, makeRecord({ updatedAt: i * 1000, content: `v${i}` }));
    }

    const fresh = createUndoStore(storePath);
    const survivors = [1, 2, 3, 4, 5, 6].filter((i) => fresh.get(`/tmp/f${i}.txt`) !== undefined);

    expect(survivors.length).toBeGreaterThan(0);
    expect(survivors.length).toBeLessThan(6);
    // Survivors form the newest suffix of the update order.
    expect(Math.min(...survivors)).toBeGreaterThan(6 - survivors.length);

    const size = statSync(storePath).size;
    expect(size).toBeLessThanOrEqual(700);
  });

  it("always keeps at least one record even when one exceeds maxBytes", () => {
    const storePath = sandboxPath("huge.jsonl");
    const store = createUndoStore(storePath, { maxBytes: 10 });
    store.put("/tmp/big.txt", makeRecord({ content: "x".repeat(500) }));

    const fresh = createUndoStore(storePath);
    expect(fresh.get("/tmp/big.txt")).toBeDefined();
  });

  it("reads are pure: they never evict or rewrite", () => {
    const storePath = sandboxPath("read-pure.jsonl");
    const writer = createUndoStore(storePath, { maxBytes: 10_000_000 });
    for (let i = 1; i <= 4; i++) {
      writer.put(`/tmp/r${i}.txt`, makeRecord({ updatedAt: i * 1000 }));
    }
    const before = statSync(storePath).size;

    const reader = createUndoStore(storePath, { maxBytes: 1 });
    expect(reader.get("/tmp/r1.txt")).toBeDefined();

    expect(statSync(storePath).size).toBe(before);
  });

  it("ignores a legacy whole-map .json sibling (no auto-migration)", () => {
    // Migration was deliberately removed: the JSONL store supersedes the old
    // whole-map dump, and stale undo snapshots are not worth migration code.
    const storePath = sandboxPath("no-migrate.jsonl");
    const legacyPath = sandboxPath("no-migrate.json");
    writeFileSync(
      legacyPath,
      JSON.stringify({ "/tmp/old.txt": makeRecord({ content: "old" }) }),
      "utf-8",
    );

    const store = createUndoStore(storePath);
    expect(store.get("/tmp/old.txt")).toBeUndefined();
    expect(existsSync(legacyPath)).toBe(true);

    // The new store works independently of the legacy sibling.
    store.put("/tmp/new.txt", makeRecord());
    expect(createUndoStore(storePath).get("/tmp/new.txt")).toBeDefined();
  });

  it("torn tail is folded away by compaction without losing intact records", () => {
    const storePath = sandboxPath("compact-torn.jsonl");
    const good = makeRecord({ content: "i".repeat(200), updatedAt: 9000 });
    writeFileSync(
      storePath,
      JSON.stringify({ path: "/tmp/intact.txt", record: good }) +
        '\n{"path":"/tmp/torn.tx","record":{"content":"cut',
      "utf-8",
    );

    const store = createUndoStore(storePath, { maxBytes: 300 });
    store.put("/tmp/after.txt", makeRecord({ content: "a".repeat(200), updatedAt: 5000 }));

    const body = readFileSync(storePath, "utf-8");
    expect(body).not.toContain("torn.tx");
    const fresh = createUndoStore(storePath);
    expect(fresh.get("/tmp/intact.txt")!.content).toBe("i".repeat(200));
    // Byte accounting decides the survivor set: intact (9000) is newest;
    // the just-appended after.txt (5000) is FIFO-dropped by the budget.
    expect(fresh.get("/tmp/after.txt")).toBeUndefined();
  });

  it("a pre-existing single-file JSONL store is read correctly (format invariance)", () => {
    const storePath = sandboxPath("legacy-jsonl.jsonl");
    const r1 = makeRecord({ content: "x".repeat(400), updatedAt: 1000 });
    const r2 = makeRecord({ content: "y".repeat(400), updatedAt: 9000 });
    writeFileSync(
      storePath,
      JSON.stringify({ path: "/tmp/a.txt", record: r1 }) +
        "\n" +
        JSON.stringify({ path: "/tmp/b.txt", record: r2 }) +
        "\n",
      "utf-8",
    );

    // FRD req 7: readable with zero migration code.
    const fresh = createUndoStore(storePath);
    expect(fresh.get("/tmp/a.txt")!.content).toBe("x".repeat(400));
    expect(fresh.get("/tmp/b.txt")!.content).toBe("y".repeat(400));

    // Compaction over the pre-existing file keeps the newest suffix.
    const tight = createUndoStore(storePath, { maxBytes: 600 });
    tight.put("/tmp/c.txt", makeRecord({ content: "z".repeat(400), updatedAt: 99000 }));
    const after = createUndoStore(storePath);
    expect(after.get("/tmp/c.txt")!.content).toBe("z".repeat(400));
    expect(after.get("/tmp/a.txt")).toBeUndefined();
    expect(after.get("/tmp/b.txt")).toBeUndefined();
  });

  it("mixed-budget compaction commits an exact-boundary body and never resurrects evicted records", () => {
    const storePath = sandboxPath("mixed-budget.jsonl");
    const newest = makeRecord({ content: "y".repeat(300), updatedAt: 7000 });
    const newestBytes = lineBytes("/tmp/mb-newest.txt", newest);

    // A wide-budget writer seeds three records; it never evicts (far under
    // its own budget).
    const wide = createUndoStore(storePath, { maxBytes: 10_000 });
    for (const [i, updatedAt] of [4000, 5000, 6000].entries()) {
      wide.put(`/tmp/mb-${i}.txt`, makeRecord({ content: "x".repeat(300), updatedAt }));
    }

    // The narrow compactor's budget equals its own newest line, so the body
    // it commits is exactly `maxBytes` bytes — the case the pre-lock
    // boundary check could not tell apart from an unchanged store, because a
    // commit at exactly the boundary is not a detected shrink.
    const narrow = createUndoStore(storePath, { maxBytes: newestBytes });
    narrow.put("/tmp/mb-newest.txt", newest);

    const body = readFileSync(storePath, "utf-8");
    expect(Buffer.byteLength(body, "utf-8")).toBe(newestBytes);

    const committed = createUndoStore(storePath);
    expect(committed.get("/tmp/mb-newest.txt")).toBeDefined();
    expect(committed.get("/tmp/mb-0.txt")).toBeUndefined();
    expect(committed.get("/tmp/mb-1.txt")).toBeUndefined();
    expect(committed.get("/tmp/mb-2.txt")).toBeUndefined();

    // The wide writer's next compaction folds the CURRENT disk state, so the
    // narrow compactor's evictions stay evicted — a pre-lock snapshot merged
    // against a tail would have brought them back.
    wide.put("/tmp/mb-after.txt", makeRecord({ content: "z".repeat(300), updatedAt: 8000 }));
    const after = createUndoStore(storePath);
    expect(after.get("/tmp/mb-newest.txt"), "exact-boundary commit survives").toBeDefined();
    expect(after.get("/tmp/mb-after.txt")).toBeDefined();
    expect(after.get("/tmp/mb-0.txt")).toBeUndefined();
    expect(after.get("/tmp/mb-1.txt")).toBeUndefined();
    expect(after.get("/tmp/mb-2.txt")).toBeUndefined();
    expect(statSync(storePath).size).toBeLessThanOrEqual(10_000);
  });

  it("a tail replace shrinking a kept record is neither dropped nor duplicated", () => {
    const storePath = sandboxPath("shrink-replace.jsonl");
    const big = makeRecord({ content: "x".repeat(300), updatedAt: 1000 });
    const budget = lineBytes("/tmp/sr-keep.txt", big) + lineBytes("/tmp/sr-shrink.txt", big);
    const store = createUndoStore(storePath, { maxBytes: budget });

    store.put("/tmp/sr-keep.txt", big);
    // Two big lines land exactly on the budget: nothing evicted yet.
    store.put("/tmp/sr-shrink.txt", big);

    // Replace the second path with a much smaller record. The compaction
    // that follows must keep both paths, with the replaced path carrying the
    // NEW content exactly once: byte accounting is recomputed over the
    // folded set, so shrinking a kept record neither drops it nor leaves the
    // stale larger line beside it.
    store.put("/tmp/sr-shrink.txt", makeRecord({ content: "s", updatedAt: 2000 }));

    const bodyLines = readFileSync(storePath, "utf-8")
      .split("\n")
      .filter((line) => line.trim());
    expect(bodyLines).toHaveLength(2);

    const fresh = createUndoStore(storePath);
    expect(fresh.get("/tmp/sr-shrink.txt")!.content).toBe("s");
    expect(fresh.get("/tmp/sr-keep.txt")!.content).toBe("x".repeat(300));
    expect(statSync(storePath).size).toBeLessThanOrEqual(budget);
  });
});

describe("eviction failure handling", () => {
  /** Store with a budget small enough that every put triggers eviction. */
  function overBudgetStore(file: string) {
    const storePath = sandboxPath(file);
    return { storePath, store: createUndoStore(storePath, { maxBytes: 600 }) };
  }

  it("recovers from a transient commit-write failure via the in-hold retry", () => {
    const { store } = overBudgetStore("retry-recover.jsonl");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    _forceCommitWriteFailure = { times: 1 };
    _commitWriteCalls = 0;
    _truncatedFd = undefined;
    try {
      store.put("/tmp/a.txt", makeRecord({ content: "x".repeat(700) }));

      // The just-appended record sits inside committedBody; the same-token
      // in-hold retry restores it — no warning, persisted contract intact.
      expect(store.get("/tmp/a.txt")!.content).toBe("x".repeat(700));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      _forceCommitWriteFailure = false;
      _commitWriteCalls = 0;
      _truncatedFd = undefined;
      warn.mockRestore();
    }
  });

  it("persistent ftruncate failure: one deduped size-vs-budget warning across puts", () => {
    const { store } = overBudgetStore("persistent-lock.jsonl");
    _forceTruncateFailure = { code: "EPERM", times: Infinity };
    _truncateCalls = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      store.put("/tmp/a.txt", makeRecord({ content: "x".repeat(700) }));
      store.put("/tmp/b.txt", makeRecord({ content: "y".repeat(700) }));

      // ftruncate fails BEFORE the truncate completed: store untouched,
      // no heal, plain eviction-failure path (fast — no retry backoff).
      const evictionWarnings = warn.mock.calls.filter((args) =>
        String(args[0]).includes("Undo store eviction failed"),
      );
      expect(evictionWarnings).toHaveLength(1);
      const message = String(evictionWarnings[0][0]);
      expect(message).toContain("over the 600-byte budget");
      expect(message).toContain("undo store is ");
      expect(message).toContain("EPERM");
    } finally {
      _forceTruncateFailure = false;
      _truncateCalls = 0;
      warn.mockRestore();
    }
  });

  it("the eviction warning resets after a successful eviction", () => {
    const { store } = overBudgetStore("warn-reset.jsonl");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const warnings = () => warn.mock.calls.filter((args) => String(args[0]).includes("failed"));
    try {
      _forceWriteFailure = "rewrite"; // tmp-write stage: instant, no backoff
      store.put("/tmp/a.txt", makeRecord({ content: "x".repeat(700) }));
      expect(warnings()).toHaveLength(1);

      _forceWriteFailure = false; // successful eviction clears the episode
      store.put("/tmp/b.txt", makeRecord({ content: "y".repeat(700) }));
      expect(warnings()).toHaveLength(1);

      _forceWriteFailure = "rewrite"; // a new breakage warns again
      store.put("/tmp/c.txt", makeRecord({ content: "z".repeat(700) }));
      expect(warnings()).toHaveLength(2);
    } finally {
      _forceWriteFailure = false;
      warn.mockRestore();
    }
  });

  it("a tmp-write failure is not mislabeled as an eviction failure", () => {
    const { store } = overBudgetStore("tmp-write-stage.jsonl");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    _forceWriteFailure = "rewrite";
    try {
      store.put("/tmp/a.txt", makeRecord({ content: "x".repeat(700) }));

      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0][0]);
      expect(message).toContain("compaction write failed");
      expect(message).not.toContain("Undo store eviction failed");
    } finally {
      _forceWriteFailure = false;
      warn.mockRestore();
    }
  });

  it("saveUndo still reports persisted: true when only eviction failed", async () => {
    const storePath = sandboxPath("evict-nonfatal.jsonl");
    const store = createUndoStore(storePath, { maxBytes: 600 });
    store.put("/tmp/seed.txt", makeRecord({ content: "x".repeat(700) })); // over budget, compacts clean

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Append window's acquire = wx call 1 (passes); compaction window's
    // acquire = call 2+ (EEXIST-exhausts) → compaction never truncates →
    // the just-appended record is intact on disk.
    _armedLockPath = `${storePath}.lock`;
    _lockOpenCalls = 0;
    _forceLockAcquireFailure = { fromCall: 2 };
    try {
      const result = await saveUndo(
        "/tmp/x.txt",
        {
          content: "pre",
          bom: "",
          originalEnding: "\n",
          resultContent: "post",
          encoding: "utf-8",
        },
        storePath,
        { maxBytes: 600 },
      );

      expect(result.persisted).toBe(true);
      expect(getUndo("/tmp/x.txt", storePath)!.content).toBe("pre");
      expect(
        warn.mock.calls.filter((args) => String(args[0]).includes("Undo store eviction failed")),
      ).toHaveLength(1);
    } finally {
      _forceLockAcquireFailure = false;
      _lockOpenCalls = 0;
      _armedLockPath = undefined;
      warn.mockRestore();
    }
  });

  it("stolen lock during commit: outer heal re-acquires and completes the commit", () => {
    const { storePath, store } = overBudgetStore("stolen-heal.jsonl");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    _armedLockPath = `${storePath}.lock`;
    _forceCommitWriteFailure = { times: 1, stealLock: true };
    _commitWriteCalls = 0;
    _truncatedFd = undefined;
    try {
      store.put("/tmp/a.txt", makeRecord({ content: "x".repeat(700) }));

      // Armed commit write fails AND replaces the lock with a dead-pid
      // payload → isCurrent() false → StolenLock → outer heal re-acquires
      // (steal on ESRCH), sees the empty truncation as a byte-prefix of
      // committedBody, and completes the commit.
      expect(store.get("/tmp/a.txt")!.content).toBe("x".repeat(700));
      expect(warn).not.toHaveBeenCalled();
      expect(existsSync(`${storePath}.lock`)).toBe(false);
    } finally {
      _forceCommitWriteFailure = false;
      _commitWriteCalls = 0;
      _truncatedFd = undefined;
      _armedLockPath = undefined;
      warn.mockRestore();
    }
  });

  it("commit failure after truncate: honest residual (record lost, warning fired, no throw)", () => {
    const { storePath, store } = overBudgetStore("commit-lost.jsonl");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    _forceCommitWriteFailure = { times: Infinity };
    _commitWriteCalls = 0;
    _truncatedFd = undefined;
    try {
      expect(() => store.put("/tmp/a.txt", makeRecord({ content: "x".repeat(700) }))).not.toThrow();

      const evictionWarnings = warn.mock.calls.filter((args) =>
        String(args[0]).includes("Undo store eviction failed"),
      );
      expect(evictionWarnings).toHaveLength(1);
      // Truncate succeeded, every commit write failed, the in-hold retry
      // failed too: the store is the empty truncation. FRD req 6's bound
      // is "where healable" — this is the documented residual class.
      expect(statSync(storePath).size).toBe(0);
      expect(store.get("/tmp/a.txt")).toBeUndefined();
    } finally {
      _forceCommitWriteFailure = false;
      _commitWriteCalls = 0;
      _truncatedFd = undefined;
      warn.mockRestore();
    }
  });
});

describe("saveUndo", () => {
  it("reports failure when the store cannot be written", async () => {
    // Route the default store path into the sandbox BEFORE the module
    // singleton is created (this is the first no-storePath call in the
    // file): the lock payload write also uses writeSync, so "all" mode
    // leaves a zero-byte lock file — never in the real pi agent data dir.
    process.env.PI_UNDO_STORE_PATH = sandboxPath("write-fail.jsonl");
    _forceWriteFailure = "all";
    try {
      const result = await saveUndo("/tmp/x.txt", {
        content: "a",
        bom: "",
        originalEnding: "\n",
        resultContent: "b",
        encoding: "utf-8",
      });

      expect(result.persisted).toBe(false);
    } finally {
      _forceWriteFailure = false;
      delete process.env.PI_UNDO_STORE_PATH;
    }
  });

  it("persists an entry and getUndo can read it back", async () => {
    const storePath = sandboxPath("saveget.jsonl");
    const key = "/tmp/x.txt";

    const result = await saveUndo(
      key,
      {
        content: "pre",
        bom: "",
        originalEnding: "\n",
        resultContent: "post",
        encoding: "utf-8",
      },
      storePath,
    );

    expect(result.persisted).toBe(true);

    const loaded = getUndo(key, storePath);
    expect(loaded).toBeDefined();
    expect(loaded!.content).toBe("pre");
    expect(loaded!.resultContent).toBe("post");
  });

  it("carries provenance fields through to getUndo", async () => {
    const storePath = sandboxPath("provenance.jsonl");
    const key = "/tmp/x.txt";

    await saveUndo(
      key,
      {
        content: "pre",
        bom: "",
        originalEnding: "\n",
        resultContent: "post",
        encoding: "utf-8",
        sessionId: "s-ab12",
        project: "/home/dev/proj",
      },
      storePath,
    );

    const loaded = getUndo(key, storePath);
    expect(loaded!.sessionId).toBe("s-ab12");
    expect(loaded!.project).toBe("/home/dev/proj");
  });

  it("restore() rolls back to previous entry", async () => {
    const storePath = sandboxPath("restore.jsonl");
    const key = "/tmp/x.txt";

    // Seed with previous entry.
    const previous = makeRecord({ content: "old", resultContent: "old-result" });
    await saveUndo(
      key,
      {
        content: previous.content,
        bom: previous.bom,
        originalEnding: previous.originalEnding,
        resultContent: previous.resultContent,
        encoding: previous.encoding,
      },
      storePath,
    );

    // Save new entry.
    const result = await saveUndo(
      key,
      {
        content: "new",
        bom: "",
        originalEnding: "\n",
        resultContent: "new-result",
        encoding: "utf-8",
      },
      storePath,
    );

    expect(result.persisted).toBe(true);
    expect(getUndo(key, storePath)!.content).toBe("new");

    // Restore to previous.
    await result.restore();
    const restored = getUndo(key, storePath);
    expect(restored).toBeDefined();
    expect(restored!.content).toBe("old");
    expect(restored!.resultContent).toBe("old-result");
  });

  it("restore() deletes entry when there was no previous", async () => {
    const storePath = sandboxPath("restore-none.jsonl");
    const key = "/tmp/x.txt";

    const result = await saveUndo(
      key,
      {
        content: "only",
        bom: "",
        originalEnding: "\n",
        resultContent: "only-result",
        encoding: "utf-8",
      },
      storePath,
    );

    expect(result.persisted).toBe(true);
    await result.restore();
    expect(getUndo(key, storePath)).toBeUndefined();
  });

  it("clearUndo removes entry", () => {
    const storePath = sandboxPath("clearsave.jsonl");
    const key = "/tmp/x.txt";

    expect(getUndo(key, storePath)).toBeUndefined();
    clearUndo(key, storePath); // should not throw on missing
    expect(getUndo(key, storePath)).toBeUndefined();
  });

  it("old-format records without rawContent/rawResult still work (backward compat)", async () => {
    const storePath = sandboxPath("backward-compat.jsonl");
    const key = "/tmp/x.txt";

    // Manually write an old-format record (no rawContent/rawResult fields)
    const store = createUndoStore(storePath);
    store.put(key, {
      content: "hello\nworld",
      bom: "",
      originalEnding: "\n",
      resultContent: "hello\nearth",
      updatedAt: Date.now(),
      encoding: "utf-8",
    });

    const loaded = getUndo(key, storePath);
    expect(loaded).toBeDefined();
    expect(loaded!.content).toBe("hello\nworld");
    expect(loaded!.resultContent).toBe("hello\nearth");
    expect(loaded!.rawContent).toBeUndefined();
    expect(loaded!.rawResult).toBeUndefined();
  });
});
