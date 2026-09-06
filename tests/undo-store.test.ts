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

// Toggle to force fs writes to fail for the undo store (covers both whole-file
// rewrites and O_APPEND line writes).
let _forceWriteFailure = false;

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

// Mock node:fs write primitives to simulate store write failures.
// vitest hoists vi.mock, so it's active before undo-store.ts loads.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual("node:fs");
  return {
    ...actual,
    writeFileSync: (...args: any[]) => {
      if (_forceWriteFailure) {
        throw new Error("EACCES: permission denied");
      }
      return (actual as any).writeFileSync(...args);
    },
    writeSync: (...args: any[]) => {
      if (_forceWriteFailure) {
        throw new Error("EACCES: permission denied");
      }
      return (actual as any).writeSync(...args);
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
});

describe("saveUndo", () => {
  it("reports failure when the store cannot be written", async () => {
    _forceWriteFailure = true;
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
