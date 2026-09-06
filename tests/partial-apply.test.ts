// Phase 3: Partial edit application tests.
//
// Verifies the new contract:
//   - resolveBlocks collects ALL errors (no short-circuit on first)
//   - executeFile applies the resolved subset and reports failures
//   - Partial success is NOT isError when ≥1 edit applied
//   - Telemetry edit.partial event is recorded

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBlocks } from "../src/edit/pipeline/resolve.js";
import { executeFile } from "../src/edit/pipeline/execute.js";
import { telemetry } from "../src/telemetry.js";

describe("partial edit application", () => {
  let dir: string;

  function write(name: string, content: string): string {
    const file = join(dir, name);
    writeFileSync(file, content);
    return file;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "partial-apply-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("resolveBlocks — collects all errors", () => {
    it("returns all errors when some edits resolve and some don't", () => {
      const outcome = resolveBlocks(
        "line1\nline2\nline3\n",
        [
          { path: "test.txt", oldText: "line1", newText: "LINE1" },
          { path: "test.txt", oldText: "missing", newText: "MISSING" },
          { path: "test.txt", oldText: "line3", newText: "LINE3" },
        ],
        "test.txt",
      );
      expect(outcome.ok).toBe(true);
      expect(outcome.resolved).toHaveLength(2);
      expect(outcome.errors).toHaveLength(1);
      expect(outcome.errors[0]!.kind).toBe("not-found");
    });

    it("returns total failure when no edits resolve", () => {
      const outcome = resolveBlocks(
        "line1\nline2\nline3\n",
        [
          { path: "test.txt", oldText: "missing1", newText: "X" },
          { path: "test.txt", oldText: "missing2", newText: "Y" },
        ],
        "test.txt",
      );
      expect(outcome.ok).toBe(false);
      expect(outcome.resolved).toHaveLength(0);
      expect(outcome.errors).toHaveLength(2);
    });

    it("returns success when all edits resolve", () => {
      const outcome = resolveBlocks(
        "line1\nline2\nline3\n",
        [
          { path: "test.txt", oldText: "line1", newText: "LINE1" },
          { path: "test.txt", oldText: "line2", newText: "LINE2" },
        ],
        "test.txt",
      );
      expect(outcome.ok).toBe(true);
      expect(outcome.resolved).toHaveLength(2);
      expect(outcome.errors).toHaveLength(0);
    });
  });

  describe("executeFile — partial apply", () => {
    it("applies 2 of 3 edits when one is not-found", async () => {
      const file = write("partial.txt", "line1\nline2\nline3\n");
      const result = await executeFile(file, [
        { oldText: "line1", newText: "LINE1" },
        { oldText: "missing", newText: "MISSING" },
        { oldText: "line3", newText: "LINE3" },
      ]);

      expect(result.isError).toBe(false);
      expect((result.details as any).isPartial).toBe(true);
      expect((result.details as any).appliedCount).toBe(2);
      expect((result.details as any).failedCount).toBe(1);
      expect(readFileSync(file, "utf8")).toBe("LINE1\nline2\nLINE3\n");
    });

    it("reports applied edit-object count, not replacement count, when replaceAll partially succeeds", async () => {
      const file = write("replaceall-partial.txt", "foo bar foo baz foo\nline2\n");
      const result = await executeFile(file, [
        { oldText: "foo", newText: "qux", replaceAll: true },
        { oldText: "line2", newText: "LINE2" },
        { oldText: "missing", newText: "MISSING" },
      ]);

      expect(result.isError).toBe(false);
      expect((result.details as any).isPartial).toBe(true);
      // 2 of 3 edit objects succeeded; replacements applied = 4
      expect((result.details as any).appliedCount).toBe(2);
      expect((result.details as any).failedCount).toBe(1);
      expect(readFileSync(file, "utf8")).toBe("qux bar qux baz qux\nLINE2\n");

      const text = result.content.map((c) => c.text || "").join("\n");
      expect(text).toContain("Applied 2 of 3 edits");
      expect(text).toContain("1 edit(s) failed:");
      expect(text).toContain("edits[2]: missing");
    });

    it("exposes raw replacement count in details.appliedEdits for debugging", async () => {
      const file = write("replaceall-details.txt", "foo bar foo baz foo\nline2\n");
      const result = await executeFile(file, [
        { oldText: "foo", newText: "qux", replaceAll: true },
        { oldText: "line2", newText: "LINE2" },
        { oldText: "missing", newText: "MISSING" },
      ]);

      expect(result.isError).toBe(false);
      const details = result.details as any;
      expect(details.appliedCount).toBe(2);
      expect(details.failedCount).toBe(1);
      // The raw number of successful match+apply operations is still
      // available for debugging via the appliedEdits array.
      expect(details.appliedEdits).toHaveLength(4);
    });

    it("returns total error when all edits fail", async () => {
      const file = write("all-fail.txt", "line1\nline2\nline3\n");
      const result = await executeFile(file, [
        { oldText: "missing1", newText: "X" },
        { oldText: "missing2", newText: "Y" },
      ]);

      expect(result.isError).toBe(true);
      expect((result.details as any).isPartial).toBeUndefined();
      // File should not have been written
      expect(readFileSync(file, "utf8")).toBe("line1\nline2\nline3\n");
    });

    it("returns full success when all edits apply", async () => {
      const file = write("all-ok.txt", "line1\nline2\nline3\n");
      const result = await executeFile(file, [
        { oldText: "line1", newText: "LINE1" },
        { oldText: "line2", newText: "LINE2" },
      ]);

      expect(result.isError).toBe(false);
      expect((result.details as any).isPartial).toBeUndefined();
      expect(readFileSync(file, "utf8")).toBe("LINE1\nLINE2\nline3\n");
    });

    it("reports both anchor-not-found and overlap failures", async () => {
      const file = write("mixed.txt", "hello world foo bar");
      const result = await executeFile(file, [
        // Genuinely unresolvable: oldText absent AND anchor absent.
        { oldText: "goodbye", newText: "bye", anchor: "no such anchor" },
        { oldText: "hello world", newText: "hi world" },
        { oldText: "world foo", newText: "earth bar" },
      ]);

      expect(result.isError).toBe(false);
      expect((result.details as any).isPartial).toBe(true);
      // First edit: anchor not found (resolve failure)
      // Second edit: applied
      // Third edit: overlaps with second (apply failure)
      expect((result.details as any).appliedCount).toBe(1);
      expect((result.details as any).failedCount).toBe(2);
      const diags = (result.details as any).diagnostics as Array<{
        index: number;
        status: string;
      }>;
      const statuses = diags.map((d: any) => d.status).sort();
      expect(statuses).toContain("missing"); // anchor not found
      expect(statuses).toContain("applied"); // second edit applied
      expect(statuses).toContain("overlap"); // third edit overlaps (already-handled mapped to overlap)
    });

    it("applies non-overlapping edits in a chain where intermediate edit overlaps", async () => {
      // Edits: A(0..10), B(5..16) overlaps A, C(12..24) overlaps B but not A
      // Expected: A and C applied, B failed
      const file = write("chain.txt", "0123456789abcdefghijklmnop");
      const result = await executeFile(file, [
        { oldText: "0123456789", newText: "A" },
        { oldText: "56789abcdef", newText: "B" },
        { oldText: "cdefghijklmn", newText: "C" },
      ]);

      expect(result.isError).toBe(false);
      expect((result.details as any).isPartial).toBe(true);
      expect((result.details as any).appliedCount).toBe(2);
      expect((result.details as any).failedCount).toBe(1);
      // Bottom-up application: C(12..24) applied first, then A(0..10)
      expect(readFileSync(file, "utf8")).toBe("AabCop");
    });

    it("reports ambiguous failures with actionable guidance", async () => {
      const file = write("ambiguous.txt", "line1\na\na\nline4\n");
      const result = await executeFile(file, [
        { oldText: "line1", newText: "LINE1" },
        { oldText: "a", newText: "A" },
      ]);

      expect(result.isError).toBe(false);
      expect((result.details as any).isPartial).toBe(true);
      expect((result.details as any).appliedCount).toBe(1);
      expect((result.details as any).failedCount).toBe(1);

      const text = result.content.map((c) => c.text || "").join("\n");
      expect(text).toContain("Applied 1 of 2 edits");
      expect(text).toContain("edits[1]:");
      // Ambiguous reason should mention the duplicate locations and
      // how to fix it, not just repeat the status.
      expect(text).toContain("text appears 2 times");
      expect(text).toContain("line 2, line 3");
      expect(text).toContain("provide more surrounding context");
      expect(text).toContain("replaceAll: true");
    });

    it("produces the 'Applied X of Y edits' message format", async () => {
      const file = write("message.txt", "line1\nline2\nline3\n");
      const result = await executeFile(file, [
        { oldText: "line1", newText: "LINE1" },
        { oldText: "missing", newText: "MISSING" },
        { oldText: "line3", newText: "LINE3" },
      ]);

      expect(result.isError).toBe(false);
      const text = result.content.map((c) => c.text || "").join("\n");
      // Core executor message format is unchanged per the plan;
      // tool-layer formatting lives in src/platform/tools/edit.ts.
      expect(text).toContain("Applied 2 of 3 edits");
      expect(text).toContain("1 edit(s) failed:");
      expect(text).toContain("edits[1]: missing");
    });
  });

  describe("telemetry — edit.partial", () => {
    it("records edit.partial with correct counts", async () => {
      telemetry.drain();
      const beforeStats = telemetry.stats();

      const file = write("telemetry.txt", "line1\nline2\nline3\n");
      await executeFile(file, [
        { oldText: "line1", newText: "LINE1" },
        { oldText: "missing", newText: "MISSING" },
        { oldText: "line3", newText: "LINE3" },
      ]);

      const stats = telemetry.stats();
      expect(stats.partialEdits).toBe(beforeStats.partialEdits + 1);

      // Verify the event shape in the ring buffer
      const events = telemetry.drain();
      const partialEvent = events.find((e) => e.type === "edit.partial");
      expect(partialEvent).toBeDefined();
      if (partialEvent && partialEvent.type === "edit.partial") {
        expect(partialEvent.appliedCount).toBe(2);
        expect(partialEvent.failedCount).toBe(1);
        expect(partialEvent.passNames).toContain("simple");
        expect(typeof partialEvent.durationMs).toBe("number");
      }
    });
  });
});
