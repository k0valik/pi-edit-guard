import { describe, it, expect } from "vitest";
import { ReadRegistry } from "../src/guards/stale-read/registry.js";

// Registry-level contract for the stale-read escalation ladder.
//
// Mined from pr-stack-era sessions (2026-08-18, commit.md flow): a path
// flagged once stayed flagged FOREVER (warned set never cleared), so every
// future genuine drift degraded straight to proceed-and-advisory, and a
// verbatim-applicable edit got hard-blocked on first contact even though its
// oldText still matched the current content byte-for-byte.
//
// New contract:
//   - record()/selfRefresh() establish a fresh known baseline and RESET the
//     ladder (next drift = one hard block again).
//   - Within ONE drifted state: first contact blocks, repeats advise.
//   - Verbatim-safe edits (ALL oldTexts present in current content, CRLF-
//     normalized) downgrade the block to advisory — the splice is provably
//     applicable; the diff review covers the rest.

function makeRegistry(opts: { mtime: number; content?: string; now?: number }) {
  let mtime = opts.mtime;
  let content = opts.content ?? "";
  let clock = opts.now ?? 1_000;
  return {
    registry: new ReadRegistry({
      now: () => clock,
      stat: () => ({ mtimeMs: mtime }),
      readFile: () => content,
      toleranceMs: 50,
    }),
    touch(next: number) {
      mtime = next;
      // Wall-clock must stay ahead of mtimes — physically real.
      clock = Math.max(clock, next + 10);
    },
    rewrite(nextContent: string) {
      content = nextContent;
    },
  };
}

const FILE = "line one\nline two\nline three\n";

describe("ReadRegistry escalation ladder", () => {
  it("repeated attempts against the SAME drifted state degrade to advisory", () => {
    const { registry, touch } = makeRegistry({ mtime: 100 });
    registry.record("/repo/f.txt"); // baseline: read at t=1000, mtime 100

    touch(5000); // external drift
    const first = registry.assertFresh("/repo/f.txt");
    expect(first?.kind).toBe("stale-read");

    // Nothing changed registry-side; model retries immediately.
    const second = registry.assertFresh("/repo/f.txt");
    expect(second?.kind).toBe("stale-read-warning");
  });

  it("a fresh baseline resets the ladder: the NEXT drift blocks again", () => {
    const { registry, touch } = makeRegistry({ mtime: 100 });
    const p = "/repo/f.txt";
    registry.record(p);

    touch(5000);
    expect(registry.assertFresh(p)?.kind).toBe("stale-read");

    // Model re-reads; registry records a fresh baseline (file still at 500).
    registry.record(p);
    expect(registry.assertFresh(p)).toBeNull();

    // LATER genuine drift must block again — the old never-cleared warned
    // set degraded this to advisory forever.
    touch(9000);
    expect(registry.assertFresh(p)?.kind).toBe("stale-read");
  });

  it("selfRefresh also resets the ladder", () => {
    const { registry, touch } = makeRegistry({ mtime: 100 });
    const p = "/repo/f.txt";
    registry.record(p);

    touch(5000);
    expect(registry.assertFresh(p)?.kind).toBe("stale-read");

    // Our own successful edit lands after the write; selfRefresh mirrors it.
    registry.selfRefresh(p);
    expect(registry.assertFresh(p)).toBeNull();

    touch(9000);
    expect(registry.assertFresh(p)?.kind).toBe("stale-read");
  });
});

describe("ReadRegistry verbatim-safe downgrade", () => {
  it("downgrades the FIRST block to advisory when ALL oldTexts match current content", () => {
    const { registry, touch } = makeRegistry({
      mtime: 100,
      content: FILE,
      now: 1_000,
    });
    const p = "/repo/f.md";
    registry.record(p);

    touch(5000); // formatter rewrote something elsewhere
    const outcome = registry.assertFresh(p, {
      oldTexts: ["line two"],
    });
    // Provably applicable: the splice target is intact byte-for-byte.
    expect(outcome?.kind).toBe("stale-read-warning");
  });

  it("the verbatim-safe downgrade is VISIBLE: getStaleWarning fires once", () => {
    const { registry, touch } = makeRegistry({
      mtime: 100,
      content: FILE,
      now: 1_000,
    });
    const p = "/repo/f.md";
    registry.record(p);

    touch(5000);
    expect(registry.assertFresh(p, { oldTexts: ["line two"] })?.kind).toBe("stale-read-warning");
    // The tool layer samples this pre-execution; a silent proceed would
    // hide real drift from the model (warn-once, per the mining contract).
    expect(registry.getStaleWarning(p)).toContain("[stale-read advisory]");

    // Our own successful write resets everything — no repeat warnings.
    registry.selfRefresh(p);
    expect(registry.getStaleWarning(p)).toBeNull();
  });

  it("keeps the hard block when oldText is gone from current content", () => {
    const { registry, touch } = makeRegistry({
      mtime: 100,
      content: FILE,
    });
    const p = "/repo/f.md";
    registry.record(p);

    touch(5000); // content changed such that oldText vanished
    const outcome = registry.assertFresh(p, {
      oldTexts: ["line nine"],
    });
    expect(outcome?.kind).toBe("stale-read");
  });

  it("requires EVERY oldText to be present (multi-edit safety)", () => {
    const { registry, touch } = makeRegistry({
      mtime: 100,
      content: FILE,
    });
    const p = "/repo/f.md";
    registry.record(p);

    touch(5000);
    const outcome = registry.assertFresh(p, {
      oldTexts: ["line two", "missing line"],
    });
    expect(outcome?.kind).toBe("stale-read");
  });

  it("counts CRLF-normalized oldText as present", () => {
    const { registry, touch } = makeRegistry({
      mtime: 100,
      content: FILE, // LF on disk
    });
    const p = "/repo/f.md";
    registry.record(p);

    touch(5000);
    const outcome = registry.assertFresh(p, {
      oldTexts: ["line two\r\nline three"],
    });
    expect(outcome?.kind).toBe("stale-read-warning");
  });

  it("no oldTexts provided keeps legacy blocking behavior", () => {
    const { registry, touch } = makeRegistry({
      mtime: 100,
      content: FILE,
    });
    const p = "/repo/f.md";
    registry.record(p);

    touch(5000);
    expect(registry.assertFresh(p)?.kind).toBe("stale-read");
    expect(registry.assertFresh(p, { oldTexts: [] })?.kind).toBe("stale-read-warning");
  });

  it("after a verbatim-safe downgrade, recovery still resets the ladder", () => {
    const { registry, touch, rewrite } = makeRegistry({
      mtime: 100,
      content: FILE,
    });
    const p = "/repo/f.md";
    registry.record(p);

    touch(5000);
    expect(registry.assertFresh(p, { oldTexts: ["line two"] })?.kind).toBe("stale-read-warning");

    // Model re-reads the drifted file → fresh baseline; formatter strikes
    // again and this time REMOVES the target lines.
    registry.record(p);
    rewrite("something else entirely\n");
    touch(9000);
    expect(registry.assertFresh(p, { oldTexts: ["line two"] })?.kind).toBe("stale-read");
  });
});

describe("getStaleWarning verbatim gating", () => {
  // Formatter-noise contract (mined 2026-09: oxfmt/prettier rewrites between
  // read and edit; the splice still lands byte-for-byte, but the advisory in
  // result text sent agents re-reading in circles). The advisory surfaces
  // only when drift plausibly affects THIS edit.
  it("stays silent when every oldText is still present (formatter drift elsewhere)", () => {
    const { registry, touch } = makeRegistry({
      mtime: 100,
      content: FILE,
      now: 1_000,
    });
    const p = "/repo/f.md";
    registry.record(p);

    touch(5000);
    expect(registry.assertFresh(p, { oldTexts: ["line two"] })?.kind).toBe("stale-read-warning");
    expect(registry.getStaleWarning(p, ["line two"])).toBeNull();
  });

  it("warns when a search text is missing from current content", () => {
    const { registry, touch } = makeRegistry({
      mtime: 100,
      content: FILE,
      now: 1_000,
    });
    const p = "/repo/f.md";
    registry.record(p);

    touch(5000);
    expect(registry.assertFresh(p)?.kind).toBe("stale-read"); // first contact blocks
    expect(registry.assertFresh(p)?.kind).toBe("stale-read-warning"); // repeat advises
    expect(registry.getStaleWarning(p, ["line nine"])).toContain("[stale-read advisory]");
  });

  it("warns when safety is unknown (no oldTexts — legacy surface)", () => {
    const { registry, touch } = makeRegistry({
      mtime: 100,
      content: FILE,
      now: 1_000,
    });
    const p = "/repo/f.md";
    registry.record(p);

    touch(5000);
    expect(registry.assertFresh(p)?.kind).toBe("stale-read");
    expect(registry.getStaleWarning(p)).toContain("[stale-read advisory]");
    expect(registry.getStaleWarning(p, [])).toContain("[stale-read advisory]");
  });

  it("warns when safety is unknown (no readFile injection — conservative)", () => {
    const registry = new ReadRegistry({
      now: () => 1_000,
      stat: () => ({ mtimeMs: 5000 }),
      toleranceMs: 50,
    });
    const p = "/repo/f.md";
    registry.record(p);
    expect(registry.assertFresh(p)?.kind).toBe("stale-read");
    expect(registry.getStaleWarning(p, ["line two"])).toContain("[stale-read advisory]");
  });

  it("stays silent when fresh regardless of oldTexts", () => {
    const { registry } = makeRegistry({ mtime: 100, content: FILE });
    const p = "/repo/f.md";
    registry.record(p);
    expect(registry.getStaleWarning(p, ["line nine"])).toBeNull();
  });
});

describe("ReadRegistry whitespace-tolerant downgrade", () => {
  // Real-world drift is usually a formatter (oxfmt/prettier reindent or
  // respace between read and edit — mined 2026-09-22, blackhole-dev
  // session: oxfmt reflowed a doc between the agent's read and edit).
  // When every oldText still resolves through a whitespace-only-tolerant
  // pass (Tier 1-3: verbatim, per-line trim, whitespace collapse,
  // indentation-flexible), the splice lands deterministically onto current
  // bytes — first contact advises instead of blocking. Content drift
  // (changed words, added suffixes, rewrapped lines) keeps the hard block:
  // that is the small-model structural-garbage case the guard exists for.
  it("downgrades to advisory on formatter reindent", () => {
    const { registry, touch, rewrite } = makeRegistry({
      mtime: 100,
      content: "function f() {\n  return 1;\n}\n",
      now: 1_000,
    });
    const p = "/repo/f.ts";
    registry.record(p);

    rewrite("function f() {\n    return 1;\n}\n"); // 2sp -> 4sp, like oxfmt
    touch(5000);
    const outcome = registry.assertFresh(p, { oldTexts: ["  return 1;"] });
    expect(outcome?.kind).toBe("stale-read-warning");
  });

  it("downgrades on intra-line respace (oxfmt markdown session shape)", () => {
    const { registry, touch, rewrite } = makeRegistry({
      mtime: 100,
      content: "Read this top to bottom before touching.\nThe first section.\n",
      now: 1_000,
    });
    const p = "/repo/doc.md";
    registry.record(p);

    rewrite("Read this top to   bottom before touching.\nThe first section.\n");
    touch(5000);
    const outcome = registry.assertFresh(p, {
      oldTexts: ["Read this top to bottom before touching.\nThe first section."],
    });
    expect(outcome?.kind).toBe("stale-read-warning");
  });

  it("keeps the hard block on content drift (multi-line search, drift inside)", () => {
    const { registry, touch, rewrite } = makeRegistry({
      mtime: 100,
      content: "aaa\nbbb\nccc\n",
      now: 1_000,
    });
    const p = "/repo/f.ts";
    registry.record(p);

    // Drifted boundary line: neither verbatim nor whitespace-tolerant
    // resolution applies — the small-model structural-garbage case.
    // (Single bare tokens like `bbb` keep the lenient verbatim-substring
    // treatment: content alone cannot tell drift residue from a legitimate
    // sub-line target, and blocking those is the annoyance this ladder
    // exists to avoid.)
    rewrite("aaa\nbbb-external\nccc\n");
    touch(5000);
    expect(registry.assertFresh(p, { oldTexts: ["bbb\nccc"] })?.kind).toBe("stale-read");
  });

  it("keeps the hard block when drift rewraps lines (word reflow)", () => {
    const { registry, touch, rewrite } = makeRegistry({
      mtime: 100,
      content: "aaa\nbbb\nccc\n",
      now: 1_000,
    });
    const p = "/repo/doc.md";
    registry.record(p);

    // Same words, new wrapping: the splice would un-reflow the formatter's
    // work, so this stays a block-and-reread, not proceed-and-warn.
    rewrite("aaa bbb\nccc\n");
    touch(5000);
    expect(registry.assertFresh(p, { oldTexts: ["aaa\nbbb\nccc"] })?.kind).toBe("stale-read");
  });

  it("stays silent in getStaleWarning when whitespace-safe", () => {
    const { registry, touch, rewrite } = makeRegistry({
      mtime: 100,
      content: "function f() {\n  return 1;\n}\n",
      now: 1_000,
    });
    const p = "/repo/f.ts";
    registry.record(p);

    rewrite("function f() {\n    return 1;\n}\n");
    touch(5000);
    expect(registry.assertFresh(p, { oldTexts: ["  return 1;"] })?.kind).toBe("stale-read-warning");
    // Drift cannot affect this edit — nothing to verify beyond the diff.
    expect(registry.getStaleWarning(p, ["  return 1;"])).toBeNull();
  });
});
