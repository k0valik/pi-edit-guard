/**
 * Concurrency harness for the lock-coordinated undo store.
 *
 * NO vi.mock in this file — real fs, real O_EXCL races across
 * worker_threads (the mock does not propagate into workers; that is the
 * point). Determinism recipe (see Verification Notes): structural
 * contention — `maxBytes: 600` makes every put an appender AND a
 * compactor — plus the expected-suffix invariant: with updatedAt =
 * i * 1000 + workerIndex, each worker's final record is among the four
 * globally-newest, so every legal FIFO slice keeps them.
 */

import { describe, it, expect, afterAll } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { execFileSync, spawn } from "node:child_process";
import { createUndoStore } from "../src/history/store.js";
import { withFileLock } from "../src/shared/file-lock.js";

const TEST_SANDBOX = mkdtempSync(join(tmpdir(), "pi-better-toolcalls-undo-conc-"));

afterAll(() => {
  // Parent-side lock cleanup after every worker joined (safe: no live
  // holders remain — workers carry no exit-time cleanup because a
  // blanket unlink would delete a live same-pid holder's lock).
  try {
    for (const entry of readdirSync(TEST_SANDBOX)) {
      if (entry.endsWith(".lock")) {
        unlinkSync(join(TEST_SANDBOX, entry));
      }
    }
    rmSync(TEST_SANDBOX, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function sandboxPath(file: string): string {
  return join(TEST_SANDBOX, file);
}

function runWorker(data: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./workers/store-writer.mjs", import.meta.url), {
      workerData: data,
    });
    worker.once("error", reject);
    worker.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`worker exit code ${code}`)),
    );
  });
}

describe("multi-writer zero-loss (FRD acceptance criterion 1)", () => {
  it("four concurrent workers compacting on every put lose zero records", async () => {
    // ~134-byte lines; the four final records sum to ~536 bytes <= the
    // 600-byte budget, so every legal FIFO slice keeps all four; total
    // appends (~13 KB) guarantee compaction fires on nearly every put.
    const storePath = sandboxPath("multi-writer.jsonl");
    const workers = 4;
    const count = 25;
    await Promise.all(
      Array.from({ length: workers }, (_, w) =>
        runWorker({
          mode: "puts",
          storePath,
          maxBytes: 600,
          prefix: `w${w}`,
          count,
          workerIndex: w,
        }),
      ),
    );

    const fresh = createUndoStore(storePath);
    for (let w = 0; w < workers; w++) {
      expect(fresh.get(`w${w}/${count - 1}.txt`), `worker ${w} final record`).toBeDefined();
    }

    // No corruption: every surviving line is a valid record of a key
    // that was actually put, and the body is newline-terminated.
    const body = readFileSync(storePath, "utf-8");
    expect(body.endsWith("\n")).toBe(true);
    for (const line of body.split("\n").filter((l) => l.trim())) {
      const parsed = JSON.parse(line) as { path: string };
      expect(parsed.path).toMatch(/^w[0-3]\/\d+\.txt$/);
    }
    expect(statSync(storePath).size).toBeLessThanOrEqual(600);
  }, 30_000);

  it("two workers racing to steal a dead-pid lock never hold it concurrently", async () => {
    const storePath = sandboxPath("steal-race.jsonl");
    const lockPath = `${storePath}.lock`;
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999_999_999, ts: Date.now(), nonce: 1 }),
      "utf-8",
    );
    const sab = new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT);

    await Promise.all([
      runWorker({ mode: "steal-race", storePath, sab }),
      runWorker({ mode: "steal-race", storePath, sab }),
    ]);

    const counters = new Int32Array(sab);
    // Statistical check (Verification Notes): Phase 1's steal re-read
    // narrows the TOCTOU window but cannot eliminate it; a double-hold
    // here is a protocol failure worth failing on.
    expect(counters[2], "double-hold flag").toBe(0);
    expect(counters[0], "holders after join").toBe(0);
    expect(existsSync(lockPath)).toBe(false);
  }, 30_000);

  it("a dead spawned pid's lock is stolen by the real liveness probe", () => {
    const storePath = sandboxPath("dead-pid.jsonl");
    const lockPath = `${storePath}.lock`;
    // The child writes a lock payload with its OWN pid and exits;
    // execFileSync returns only after exit, so the pid is dead (ESRCH).
    // --input-type=commonjs pins require() availability regardless of the
    // package's type:module.
    execFileSync(
      process.execPath,
      [
        "--input-type=commonjs",
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(lockPath)},` +
          ` JSON.stringify({ pid: process.pid, ts: Date.now(), nonce: 42 }))`,
      ],
      { encoding: "utf-8" },
    );
    expect(existsSync(lockPath)).toBe(true);

    let ran = false;
    withFileLock(storePath, () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe("Windows FILE_SHARE_DELETE (FRD acceptance criterion 2)", () => {
  it.skipIf(process.platform !== "win32")(
    "a handle held without FILE_SHARE_DELETE never tears the store",
    async () => {
      const storePath = sandboxPath("share-delete.jsonl");
      const seed = createUndoStore(storePath, { maxBytes: 600 });
      seed.put("s/0.txt", {
        content: "c",
        bom: "",
        originalEnding: "\n",
        resultContent: "r",
        updatedAt: 1,
        encoding: "utf-8",
      });

      // FileShare.Read omits Write AND Delete sharing: while the handle
      // lives, the append's openSync("a+") and the commit write can both
      // fail — the contract is soft failure with data preserved, never a
      // torn store.
      const ps = spawn(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `$f=[System.IO.File]::Open('${storePath}','Open','Read','Read');` +
            " Start-Sleep -Seconds 3; $f.Close()",
        ],
        { stdio: "ignore" },
      );
      ps.once("error", () => {
        // A spawn failure must not hang the exit promise below.
      });
      await new Promise((resolve) => setTimeout(resolve, 750)); // handle attach

      try {
        const store = createUndoStore(storePath, { maxBytes: 600 });
        store.put("s/1.txt", {
          content: "c",
          bom: "",
          originalEnding: "\n",
          resultContent: "r",
          updatedAt: 2,
          encoding: "utf-8",
        });
      } catch {
        // Soft failure is an allowed outcome (persisted:false class); the
        // assertions below pin data preservation either way.
      }
      await new Promise((resolve) => ps.once("exit", () => resolve(undefined)));

      // Data preserved: the pre-handle record survives on every outcome
      // (failed append leaves the store untouched; a successful put's
      // compaction keeps both records — ~268 bytes <= the 600 budget).
      const after = readFileSync(storePath, "utf-8");
      expect(after).toContain("s/0.txt");
      expect(after.endsWith("\n")).toBe(true);
      for (const line of after.split("\n").filter((l) => l.trim())) {
        JSON.parse(line); // throws on corruption — never a torn store
      }
    },
    30_000,
  );
});
