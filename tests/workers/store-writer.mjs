/**
 * Worker entry for the undo-store concurrency harness.
 *
 * Loads the TypeScript sources through in-process jiti (createJiti) so the
 * tests always exercise current source — never a stale dist build. Any
 * import error is a hard fail: silent degradation would prove nothing.
 *
 * Modes (workerData.mode):
 * - "puts": runs `count` puts against the shared store, then deletes its
 *   own first key (tombstone path under real contention). updatedAt =
 *   i * 1000 + workerIndex makes each worker's LAST record one of the
 *   globally-newest, so the parent's expected-suffix assertion is
 *   deterministic despite arbitrary interleaving.
 * - "steal-race": acquires the store lock and records concurrent holders
 *   in a SharedArrayBuffer counter; a second holder sets the double-hold
 *   flag.
 *
 * No exit-time lock cleanup: withFileLock releases in its finally, so a
 * normal or exception-unwound exit never leaks; a blanket unlink-at-exit
 * would instead delete a live same-pid holder's lock (workers share the
 * parent pid).
 */
import { createJiti } from "jiti";
import { workerData, parentPort } from "node:worker_threads";

const jiti = createJiti(import.meta.url);

let storeModule;
let fileLockModule;
try {
  storeModule = await jiti.import("../../src/history/store.js");
  fileLockModule = await jiti.import("../../src/shared/file-lock.js");
} catch (error) {
  console.error("store-writer: failed to import TS sources via jiti — hard fail:", error);
  process.exit(1);
}

const { mode, storePath, maxBytes, prefix, count, workerIndex, sab } = workerData;

if (mode === "puts") {
  const store = storeModule.createUndoStore(storePath, { maxBytes });
  for (let i = 0; i < count; i++) {
    store.put(`${prefix}/${i}.txt`, {
      content: "c",
      bom: "",
      originalEnding: "\n",
      resultContent: "r",
      updatedAt: i * 1000 + workerIndex,
      encoding: "utf-8",
    });
  }
  // Tombstone path under contention: delete this worker's first key.
  store.delete(`${prefix}/0.txt`);
} else if (mode === "steal-race") {
  const counters = new Int32Array(sab);
  fileLockModule.withFileLock(storePath, () => {
    const concurrent = Atomics.add(counters, 0, 1);
    if (concurrent > 0) {
      Atomics.store(counters, 2, 1); // double-hold flag
    }
    // Hold ~50 ms via the never-written slot 1 (the same Atomics.wait
    // trick as sleepSync) to widen the overlap window for the counter.
    Atomics.wait(counters, 1, 0, 50);
    Atomics.sub(counters, 0, 1);
  });
}

parentPort.postMessage({ done: true, mode, prefix });
