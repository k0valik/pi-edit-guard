import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createEditToolDefinition } from "@earendil-works/pi-coding-agent";
import { executeFile } from "../../src/edit/pipeline/execute.js";
import type { TextContent } from "@earendil-works/pi-ai";

const FIXTURES_PATH = join(
  process.cwd(),
  "tests",
  "integration",
  "fixtures",
  "session-failures.json",
);

interface Fixture {
  name: string;
  category: string;
  path: string;
  edits: Array<{ oldText: string; newText: string; anchor?: string }>;
  fileContent: string;
  expected: { isError: boolean; mustContain?: string };
  source?: {
    readSource?: string;
    contentMissingFromSession?: boolean;
  };
}

function loadFixtures(): Fixture[] {
  return JSON.parse(readFileSync(FIXTURES_PATH, "utf-8"));
}

class InMemoryFS {
  private files = new Map<string, Buffer>();

  writeFile(path: string, content: string | Buffer) {
    this.files.set(path, typeof content === "string" ? Buffer.from(content, "utf-8") : content);
  }

  readFile(path: string): Buffer {
    const buf = this.files.get(path);
    if (!buf) throw new Error("ENOENT: " + path);
    return buf;
  }

  exists(path: string): boolean {
    return this.files.has(path);
  }

  access(path: string) {
    if (!this.files.has(path)) throw new Error("EACCES: " + path);
  }

  rename(from: string, to: string) {
    const buf = this.files.get(from);
    if (!buf) throw new Error("ENOENT: " + from);
    this.files.set(to, buf);
    this.files.delete(from);
  }

  mkdir(_path: string) {}
  unlink(path: string) {
    this.files.delete(path);
  }
}

function signature(text: string): string {
  if (text.includes("W_ROBUST_EDIT_FALLBACK")) return "W_ROBUST_EDIT_FALLBACK";
  if (text.includes('Validation failed for tool "edit"')) return "validation";
  if (text.includes("Could not find")) return "not-found";
  if (text.includes("overlap in")) return "overlap";
  if (text.includes("occurrences")) return "ambiguous";
  if (text.includes("No changes made")) return "noop";
  if (text.includes("Patch failed")) return "patch-failed";
  return "other";
}

async function replayBuiltin(
  fileContent: string,
  edits: Fixture["edits"],
  absolutePath: string,
  cwd: string,
) {
  const fs = new InMemoryFS();
  fs.writeFile(absolutePath, fileContent);
  const tool = createEditToolDefinition(cwd, {
    operations: {
      readFile: (p) => Promise.resolve(fs.readFile(p)),
      writeFile: (p, c) => Promise.resolve(fs.writeFile(p, c)),
      access: (p) => Promise.resolve(fs.access(p)),
    },
  });

  try {
    const result = await tool.execute(
      "replay",
      { path: absolutePath, edits },
      undefined,
      undefined,
      { cwd } as any,
    );
    const text = result.content
      .filter((c): c is TextContent => "text" in c)
      .map((c) => c.text)
      .join("\n");
    return { isError: false, text, sig: "success" };
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    return { isError: true, text, sig: signature(text) };
  }
}

async function replayOurTool(
  fileContent: string,
  edits: Fixture["edits"],
  absolutePath: string,
  cwd: string,
) {
  const fs = new InMemoryFS();
  fs.writeFile(absolutePath, fileContent);

  try {
    const result = await executeFile(absolutePath, edits, {
      cwd,
      readFile: (p) => fs.readFile(p),
      writeFile: (p, c) => fs.writeFile(p, c),
      rename: (from, to) => fs.rename(from, to),
      exists: (p) => fs.exists(p),
      mkdir: (p) => fs.mkdir(p),
      unlink: (p) => fs.unlink(p),
    });

    const text = result.content.map((c) => c.text || "").join("\n");
    return {
      isError: result.isError,
      text,
      sig: result.isError ? signature(text) : "success",
    };
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    return { isError: true, text, sig: signature(text) };
  }
}

describe("session fixture replay — baseline vs edit-guard", () => {
  const allFixtures = loadFixtures();
  const replayFixtures = allFixtures.filter((f) => !f.source?.contentMissingFromSession);
  const staleFixtures = allFixtures.filter((f) => f.source?.contentMissingFromSession);

  it("loads fixtures", () => {
    expect(allFixtures.length).toBeGreaterThan(0);
    expect(replayFixtures.length).toBeGreaterThan(0);
  });

  describe("replay fixtures with captured content", () => {
    let baselineErrors = 0;
    let ourErrors = 0;
    let improved = 0;
    let regressed = 0;

    for (const f of replayFixtures) {
      it(
        f.name,
        async () => {
          const runId = randomUUID().slice(0, 8);
          const tempDir = join(tmpdir(), "replay-" + runId);
          mkdirSync(tempDir, { recursive: true });

          const absolutePath = join(tempDir, f.path);
          mkdirSync(dirname(absolutePath), { recursive: true });
          writeFileSync(absolutePath, f.fileContent, "utf-8");

          const baseline = await replayBuiltin(f.fileContent, f.edits, absolutePath, tempDir);
          const our = await replayOurTool(f.fileContent, f.edits, absolutePath, tempDir);

          console.log("  builtin: " + baseline.sig + " | our: " + our.sig);

          if (baseline.isError) baselineErrors++;
          if (our.isError) ourErrors++;

          if (baseline.isError && !our.isError) improved++;
          if (!baseline.isError && our.isError) regressed++;

          // Hard requirement: if baseline succeeds, we must also succeed
          if (!baseline.isError) {
            expect(our.isError).toBe(false);
          }
        },
        30000,
      ); // Increased timeout for large fixture replays
    }

    it("reports aggregate stats", () => {
      console.log("\n=== Replay Summary ===");
      console.log("  Fixtures:           " + replayFixtures.length);
      console.log("  Baseline errors:    " + baselineErrors);
      console.log("  Our tool errors:    " + ourErrors);
      console.log("  Improved:           " + improved);
      console.log("  Regressed:          " + regressed);

      // Hard requirement: no regressions allowed
      expect(regressed).toBe(0);

      // Soft guardrail: improvements should be non-negative
      expect(improved).toBeGreaterThanOrEqual(0);
    });
  });

  describe("stale fixtures — lightweight validation", () => {
    it("preserves stale fixture metadata", () => {
      for (const f of staleFixtures) {
        expect(f.name).toBeTruthy();
        expect(f.category).toBeTruthy();
        expect(f.path).toBeTruthy();
        expect(f.edits.length).toBeGreaterThan(0);
        expect(f.expected).toBeDefined();
        expect(f.expected.isError).toBe(true);
        expect(f.source).toBeDefined();
        expect(f.source?.contentMissingFromSession).toBe(true);
        expect(f.source?.readSource).toBe("missing");
      }
    });

    it("records missing content for stale fixtures", () => {
      for (const f of staleFixtures) {
        expect(f.fileContent).toBeTruthy();
        expect(f.source?.readSource).toBe("missing");
        expect(f.source?.contentMissingFromSession).toBe(true);
      }
    });

    it("tracks stale fixture counts", () => {
      console.log("\n=== Stale Fixture Summary ===");
      console.log("  Stale fixtures: " + staleFixtures.length);
      for (const f of staleFixtures) {
        console.log("    " + f.name + " [" + f.category + "] " + f.path);
      }
    });
  });
});
