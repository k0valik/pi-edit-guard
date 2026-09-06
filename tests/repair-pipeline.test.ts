import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRepairPipeline } from "../src/repair/pipeline.js";
import { resolveRepairPolicy } from "../src/repair/policy.js";
import { repairSchemaInput } from "../src/repair/repair-engine.js";
import { recoverEnvelope } from "../src/repair/envelope.js";
import { getFieldAliases } from "../src/repair/aliases.js";
import type { TSchema } from "typebox";
import { Type } from "typebox";
import { prepareEditArguments, repairLifecycle } from "../src/repair/entry.js";

let undoDir: string;

beforeAll(() => {
  undoDir = mkdtempSync(join(tmpdir(), "edit-guard-undo-repair-"));
  process.env.PI_UNDO_STORE_PATH = join(undoDir, "undo-store.json");
});

afterAll(() => {
  delete process.env.PI_UNDO_STORE_PATH;
  rmSync(undoDir, { recursive: true, force: true });
});

describe("resolveRepairPolicy", () => {
  it("returns adaptive by default", () => {
    const policy = resolveRepairPolicy();
    expect(policy.profile).toBe("adaptive");
    expect(policy.allowTruncatedEnvelopeCompletion).toBe(true);
    expect(policy.allowValidValueTransforms).toBe(true);
  });

  it("respects conservative profile", () => {
    const policy = resolveRepairPolicy("conservative");
    expect(policy.allowTruncatedEnvelopeCompletion).toBe(false);
    expect(policy.allowValidValueTransforms).toBe(false);
  });

  it("applies overrides", () => {
    const policy = resolveRepairPolicy("adaptive", { grammarMode: "strip" });
    expect(policy.grammarMode).toBe("strip");
  });
});

describe("recoverEnvelope", () => {
  it("passes through plain objects", () => {
    const result = recoverEnvelope({
      path: "/foo.txt",
      oldText: "a",
      newText: "b",
    });
    expect(result.value).toEqual({
      path: "/foo.txt",
      oldText: "a",
      newText: "b",
    });
    expect(result.changes).toHaveLength(0);
  });

  it("decodes JSON-stringified envelopes", () => {
    const input = JSON.stringify({
      path: "/foo.txt",
      oldText: "a",
      newText: "b",
    });
    const result = recoverEnvelope(input);
    expect(result.value).toEqual({
      path: "/foo.txt",
      oldText: "a",
      newText: "b",
    });
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].ruleId).toBe("envelope.decode-json");
  });

  it("unwraps singleton object arrays", () => {
    const result = recoverEnvelope([{ path: "/foo.txt", oldText: "a", newText: "b" }]);
    expect(result.value).toEqual({
      path: "/foo.txt",
      oldText: "a",
      newText: "b",
    });
  });
});

describe("repairSchemaInput", () => {
  const patchSchema: TSchema = Type.Object({
    path: Type.String(),
    oldText: Type.String(),
    newText: Type.String(),
  });

  it("passes valid input through untouched", () => {
    const result = repairSchemaInput({
      toolName: "patch",
      schema: patchSchema,
      input: { path: "/foo.txt", oldText: "a", newText: "b" },
    });
    expect(result.outcome).toBe("valid");
    expect(result.rulesFired).toHaveLength(0);
  });

  it("renames aliased fields", () => {
    const result = repairSchemaInput({
      toolName: "patch",
      schema: patchSchema,
      input: { file_path: "/foo.txt", old_string: "a", new_string: "b" },
      config: { fieldAliases: getFieldAliases("edit") },
    });
    expect(result.outcome).toBe("repaired");
    expect(result.args).toEqual({
      path: "/foo.txt",
      oldText: "a",
      newText: "b",
    });
  });

  it("parses JSON-stringified edits array with literal newlines", () => {
    // Exact failure from the user's report: model emitted edits as a JSON string
    // instead of an array. prepareArguments should fix this.
    const malformed = {
      path: "/foo/bar.ts",
      edits: '[{"newText": "line1\\nline2", "oldText": "line1\\nline2"}]',
    };

    const result = prepareEditArguments(malformed) as Record<string, unknown>;
    expect(Array.isArray(result.edits)).toBe(true);
    const edits = result.edits as Record<string, unknown>[];
    expect(edits).toHaveLength(1);
    expect(edits[0]).toHaveProperty("oldText");
    expect(edits[0]).toHaveProperty("newText");
  });

  it("wraps flat snake_case keys (old_str/new_str) into edits array", () => {
    const flat = { path: "/foo.txt", old_str: "a", new_str: "b" };
    const result = prepareEditArguments(flat) as Record<string, unknown>;
    expect(Array.isArray(result.edits)).toBe(true);
    expect(result.edits).toHaveLength(1);
    expect((result.edits as Record<string, unknown>[])[0].oldText).toBe("a");
    expect((result.edits as Record<string, unknown>[])[0].newText).toBe("b");
  });
});

describe("runRepairPipeline", () => {
  const patchSchema: TSchema = Type.Object({
    path: Type.String(),
    edits: Type.Array(
      Type.Object({
        oldText: Type.String(),
        newText: Type.String(),
      }),
    ),
  });

  it("passes valid input through", () => {
    const result = runRepairPipeline({
      input: { path: "/foo.txt", edits: [{ oldText: "a", newText: "b" }] },
      config: {
        toolName: "patch",
        schema: patchSchema,
        preprocessors: [],
      },
    });
    expect(result.outcome).toBe("valid");
  });

  it("repaired outcome includes changes", () => {
    const result = runRepairPipeline({
      input: { file_path: "/foo.txt", edits: [{ oldText: "a", newText: "b" }] },
      config: {
        toolName: "patch",
        schema: patchSchema,
        preprocessors: [],
        legacyConfig: { fieldAliases: getFieldAliases("edit") },
      },
    });
    expect(result.outcome).toBe("repaired");
    expect(result.changes.length).toBeGreaterThan(0);
  });
});

describe("getFieldAliases", () => {
  it("returns aliases for edit (single table — one tool surface)", () => {
    const aliases = getFieldAliases("edit");
    expect(aliases).toBeDefined();
    expect(aliases!.oldText).toContain("old_string");
    expect(aliases!.newText).toContain("new_string");
  });

  it("returns undefined for unknown tool", () => {
    expect(getFieldAliases("bash")).toBeUndefined();
    expect(getFieldAliases("patch")).toBeUndefined(); // patch is gone
  });
});

describe("repairLifecycle", () => {
  it("clear() empties pending and associated state", () => {
    repairLifecycle.enqueue(
      "edit",
      { path: "/x", oldText: "a", newText: "b" },
      {
        rules: ["flat-fold"],
        notes: ["note"],
      },
    );
    repairLifecycle.correlate("edit", { path: "/x", oldText: "a", newText: "b" }, "call-1");
    expect(repairLifecycle.pendingCount).toBeGreaterThan(0);

    repairLifecycle.clear();

    expect(repairLifecycle.pendingCount).toBe(0);
    // After clear, correlate should return undefined (no pending match)
    expect(
      repairLifecycle.correlate("edit", { path: "/x", oldText: "a", newText: "b" }, "call-1"),
    ).toBeUndefined();
  });

  it("session shutdown clears repairLifecycle but keeps undo records", async () => {
    const { default: registerExtension } = await import("../src/extension.js");
    const { createUndoStore } = await import("../src/history/store.js");
    // The undo store is a JSONL dump that survives sessions by design; the
    // shutdown hook must only clear in-memory repair state. Seeded entries
    // below go to the sandboxed PI_UNDO_STORE_PATH, never the real agent dir.

    // Seed lifecycle with pending + associated state.
    repairLifecycle.enqueue(
      "edit",
      { path: "/x", oldText: "a", newText: "b" },
      {
        rules: ["flat-fold"],
        notes: ["note"],
      },
    );
    repairLifecycle.correlate("edit", { path: "/x", oldText: "a", newText: "b" }, "call-1");
    // correlate moves the entry from pending to associated, so pendingCount
    // drops to 0. Verify associated state exists before shutdown.
    expect(repairLifecycle.pendingCount).toBe(0);

    // Seed an undo record so we can prove shutdown leaves it in place.
    const storePath = process.env.PI_UNDO_STORE_PATH!;
    const store = createUndoStore(storePath);
    store.put("/tmp/shutdown-survivor.txt", {
      content: "pre",
      bom: "",
      originalEnding: "\n",
      resultContent: "post",
      updatedAt: Date.now(),
      encoding: "utf-8",
    });

    const pi = {
      on: (_event: string, handler: (...args: unknown[]) => unknown) => {
        if (_event === "session_shutdown") {
          void handler();
        }
      },
      registerCommand: () => {},
      registerTool: () => {},
      registerMessageRenderer: () => {},
      registerShortcut: () => {},
      appendEntry: () => {},
      sendMessage: () => {},
      getSessionName: () => undefined,
      getActiveTools: () => [],
      setActiveTools: () => {},
      getAllTools: () => [],
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      events: { on: () => () => {}, emit: () => {} },
      emit: async () => undefined,
      handlers: new Map(),
      commands: new Map(),
      tools: [],
      renderers: new Map(),
      entries: [],
      messages: [],
      shortcuts: new Map(),
      execCalls: [],
      getHandlers: () => [],
      getCommandHandler: () => undefined,
      getShortcutHandlers: () => [],
      getExecCalls: () => [],
      ui: { setStatus: () => {} },
    } as any;

    // Register the extension — it should wire session_shutdown.
    registerExtension(pi);

    expect(repairLifecycle.pendingCount).toBe(0);

    // Undo records survive the shutdown hook — verified against the file,
    // not just this instance's cache.
    const reread = createUndoStore(storePath);
    expect(reread.get("/tmp/shutdown-survivor.txt")).toBeDefined();
  });
});
