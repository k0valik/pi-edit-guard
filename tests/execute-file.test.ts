import { describe, it, expect, vi } from "vitest";
import { executeFile } from "../src/edit/pipeline/execute.js";

describe("executeFile", () => {
  const originalContent = "line1\nline2\nline3\nline4\nline5";

  it("applies multiple edits atomically to the same snapshot", async () => {
    const files: Record<string, Buffer | string> = {
      "/tmp/test.txt": Buffer.from(originalContent, "utf-8"),
    };

    const result = await executeFile(
      "/tmp/test.txt",
      [
        { oldText: "line1", newText: "LINE1" },
        { oldText: "line5", newText: "LINE5" },
      ],
      {
        readFile: (p) => files[p] as Buffer,
        writeFile: (p, data) => {
          files[p] = data;
        },
        rename: (from, to) => {
          files[to] = files[from] ?? Buffer.alloc(0);
        },
        exists: () => true,
      },
    );

    expect(result.isError).toBe(false);
    // editsApplied carries the sorted block indices that applied.
    expect(result.details?.editsApplied).toEqual([0, 1]);
    const written = String(files["/tmp/test.txt"]);
    expect(written).toBe("LINE1\nline2\nline3\nline4\nLINE5");
    // Verify untouched regions are byte-for-byte identical
    expect(written.slice(6, 24)).toBe("line2\nline3\nline4\n");
  });

  it("rejects the entire patch if one edit cannot be found", async () => {
    const files: Record<string, Buffer | string> = {
      "/tmp/test.txt": Buffer.from(originalContent, "utf-8"),
    };

    const result = await executeFile(
      "/tmp/test.txt",
      [
        { oldText: "line1", newText: "LINE1" },
        { oldText: "nonexistent", newText: "XXX" },
      ],
      {
        readFile: (p) => files[p] as Buffer,
        writeFile: (p, data) => {
          files[p] = data;
        },
        rename: (from, to) => {
          files[to] = files[from] ?? Buffer.alloc(0);
        },
        exists: () => true,
      },
    );

    expect(result.isError).toBe(false);
    expect(result.details.isPartial).toBe(true);
    expect((result.details as any).appliedCount).toBe(1);
    expect((result.details as any).failedCount).toBe(1);
    // The first edit was applied, so the file WAS written
    expect(String(files["/tmp/test.txt"])).toBe("LINE1\nline2\nline3\nline4\nline5");
  });

  it("detects overlapping edits and rejects the patch", async () => {
    const content = "hello world foo bar";
    const files: Record<string, Buffer | string> = {
      "/tmp/test.txt": Buffer.from(content, "utf-8"),
    };

    const result = await executeFile(
      "/tmp/test.txt",
      [
        { oldText: "hello world", newText: "hi world" },
        { oldText: "world foo", newText: "earth bar" },
      ],
      {
        readFile: (p) => files[p] as Buffer,
        writeFile: (p, data) => {
          files[p] = data;
        },
        rename: (from, to) => {
          files[to] = files[from] ?? Buffer.alloc(0);
        },
        exists: () => true,
      },
    );

    expect(result.isError).toBe(false);
    expect(result.details.isPartial).toBe(true);

    expect((result.details as any).appliedCount).toBe(1);
    expect((result.details as any).failedCount).toBe(1);
    // Bottom-up application: higher-start edit is applied first; the
    // overlapping lower-start edit is reported as already-handled
    // (mapped to "overlap" status for backward compatibility).
    expect(String(files["/tmp/test.txt"])).toBe("hello earth bar bar");
  });

  it("preserves CRLF in untouched regions", async () => {
    const content = "line1\r\nline2\r\nline3";
    const files: Record<string, Buffer | string> = {
      "/tmp/test.txt": Buffer.from(content, "utf-8"),
    };

    const result = await executeFile("/tmp/test.txt", [{ oldText: "line2", newText: "LINE2" }], {
      readFile: (p) => files[p] as Buffer,
      writeFile: (p, data) => {
        files[p] = data;
      },
      rename: (from, to) => {
        files[to] = files[from] ?? Buffer.alloc(0);
      },
      exists: () => true,
    });

    expect(result.isError).toBe(false);
    const written = String(files["/tmp/test.txt"]);
    expect(written).toBe("line1\r\nLINE2\r\nline3");
  });

  it("resolves relative paths against cwd before reading", async () => {
    const files: Record<string, Buffer | string> = {
      "/tmp/cwd/test.txt": Buffer.from(originalContent, "utf-8"),
    };
    const seenPaths: string[] = [];

    const result = await executeFile("test.txt", [{ oldText: "line3", newText: "LINE3" }], {
      cwd: "/tmp/cwd",
      readFile: (p) => {
        seenPaths.push(p);
        return files[p] as Buffer;
      },
      writeFile: (p, data) => {
        files[p] = data;
      },
      rename: (from, to) => {
        files[to] = files[from] ?? Buffer.alloc(0);
      },
      exists: () => true,
    });

    expect(result.isError).toBe(false);
    expect(seenPaths[0]).toBe("/tmp/cwd/test.txt");
    expect(String(files["/tmp/cwd/test.txt"])).toBe("line1\nline2\nLINE3\nline4\nline5");
  });

  it("unlinks the temp file when the rename fails (no litter)", async () => {
    const files: Record<string, Buffer | string> = {
      "/tmp/test.txt": Buffer.from(originalContent, "utf-8"),
    };
    const unlink = vi.fn();
    const exists = vi.fn((p: string) => p in files);

    const result = await executeFile("/tmp/test.txt", [{ oldText: "line1", newText: "LINE1" }], {
      readFile: (p) => files[p] as Buffer,
      writeFile: (p, data) => {
        files[p] = data;
      },
      rename: () => {
        throw new Error("EACCES: permission denied");
      },
      exists,
      unlink,
    });

    expect(result.isError).toBe(true);
    expect(result.details?.error).toBe("write-failed");
    // The temp file must be unlinked, not left behind
    expect(unlink).toHaveBeenCalledTimes(1);
    const tmpPath = unlink.mock.calls[0]?.[0] as string;
    expect(tmpPath).toMatch(/\.edit-guard-.*\.tmp$/);
    // Original file untouched
    expect(String(files["/tmp/test.txt"])).toBe(originalContent);
  });

  it("wraps the whole read-modify-write cycle in the mutation queue", async () => {
    const files: Record<string, Buffer | string> = {
      "/tmp/test.txt": Buffer.from(originalContent, "utf-8"),
    };
    const queueKey: string[] = [];
    let readsInsideQueue = 0;

    const result = await executeFile("/tmp/test.txt", [{ oldText: "line1", newText: "LINE1" }], {
      readFile: (p) => {
        if (queueKey.length > 0) readsInsideQueue++;
        return files[p] as Buffer;
      },
      writeFile: (p, data) => {
        files[p] = data;
      },
      rename: (from, to) => {
        files[to] = files[from] ?? Buffer.alloc(0);
      },
      exists: () => true,
      mutationQueue: async (filePath, fn) => {
        queueKey.push(filePath);
        return fn();
      },
    });

    expect(result.isError).toBe(false);
    expect(queueKey).toEqual(["/tmp/test.txt"]); // resolved path as queue key
    expect(readsInsideQueue).toBeGreaterThan(0);
  });

  it("honors the anchor window end-to-end (file-level-ambiguous oldText)", async () => {
    // "MARKER" appears twice; the anchor restricts the search to the first.
    const content = [
      "aaa",
      "MARKER",
      "bbb",
      "ccc",
      "ddd",
      "eee",
      "fff",
      "ggg",
      "hhh",
      "iii",
      "jjj",
      "kkk",
      "lll",
      "mmm",
      "nnn",
      "ooo",
      "ppp",
      "qqq",
      "rrr",
      "sss",
      "ttt",
      "uuu",
      "vvv",
      "www",
      "xxx",
      "yyy",
      "zzz",
      "MARKER",
    ].join("\n");
    const files: Record<string, Buffer | string> = {
      "/tmp/test.txt": Buffer.from(content, "utf-8"),
    };

    const result = await executeFile(
      "/tmp/test.txt",
      [{ oldText: "MARKER", newText: "HIT", anchor: "aaa" }],
      {
        readFile: (p) => files[p] as Buffer,
        writeFile: (p, data) => {
          files[p] = data;
        },
        rename: (from, to) => {
          files[to] = files[from] ?? Buffer.alloc(0);
        },
        exists: () => true,
      },
    );

    expect(result.isError).toBe(false);
    const written = String(files["/tmp/test.txt"]);
    expect(written.split("\n").filter((l) => l === "HIT")).toHaveLength(1);
    expect(written.split("\n").filter((l) => l === "MARKER")).toHaveLength(1);
  });

  it("strips the BOM for matching and restores it on write (native parity)", async () => {
    const files: Record<string, Buffer | string> = {
      "/tmp/bom.txt": Buffer.from("\uFEFFconst a = 1;\nconst b = 2;\n", "utf-8"),
    };

    // oldText starts at the very first line — must match despite the BOM
    const result = await executeFile(
      "/tmp/bom.txt",
      [{ oldText: "const a = 1;", newText: "const a = 42;" }],
      {
        readFile: (p) => files[p] as Buffer,
        writeFile: (p, data) => {
          files[p] = data;
        },
        rename: (from, to) => {
          files[to] = files[from] ?? Buffer.alloc(0);
        },
        exists: () => true,
      },
    );

    expect(result.isError).toBe(false);
    const written = String(files["/tmp/bom.txt"]);
    expect(written.startsWith("\uFEFF")).toBe(true); // BOM preserved
    expect(written).toBe("\uFEFFconst a = 42;\nconst b = 2;\n");
    // Matching space is BOM-free: base/new content start with the first line
    expect(result.details?.baseContent).toBe("const a = 1;\nconst b = 2;\n");
    expect(result.details?.newContent).toBe("const a = 42;\nconst b = 2;\n");
  });

  it("exposes BOM-free base/new content and durationMs for diff construction", async () => {
    const files: Record<string, Buffer | string> = {
      "/tmp/t.txt": Buffer.from("aa\r\nbb\r\n", "utf-8"),
    };
    const result = await executeFile("/tmp/t.txt", [{ oldText: "aa", newText: "AA" }], {
      readFile: (p) => files[p] as Buffer,
      writeFile: (p, data) => {
        files[p] = data;
      },
      rename: (from, to) => {
        files[to] = files[from] ?? Buffer.alloc(0);
      },
      exists: () => true,
    });

    expect(result.isError).toBe(false);
    expect(result.details?.baseContent).toBe("aa\nbb\n"); // LF-normalized
    expect(result.details?.newContent).toBe("AA\nbb\n");
    expect(result.details?.durationMs).toEqual(expect.any(Number));
    // File still written byte-preserving (CRLF untouched regions survive)
    expect(String(files["/tmp/t.txt"])).toBe("AA\r\nbb\r\n");
  });

  it("exposes bom and originalEnding in details for undo metadata", async () => {
    const files: Record<string, Buffer | string> = {
      "/tmp/t.txt": Buffer.from("aa\r\nbb\r\n", "utf-8"),
    };
    const result = await executeFile("/tmp/t.txt", [{ oldText: "aa", newText: "AA" }], {
      readFile: (p) => files[p] as Buffer,
      writeFile: (p, data) => {
        files[p] = data;
      },
      rename: (from, to) => {
        files[to] = files[from] ?? Buffer.alloc(0);
      },
      exists: () => true,
    });

    expect(result.isError).toBe(false);
    expect(result.details?.bom).toBe("");
    expect(result.details?.originalEnding).toBe("\r\n");
  });

  it("performs post-write re-read on partial apply when mutationQueue is present", async () => {
    const files: Record<string, Buffer | string> = {
      "/tmp/partial-re.txt": Buffer.from("line1\nline2\nline3\n", "utf-8"),
    };
    // Make the second read (post-write re-read) differ from what was written.
    let reads = 0;
    const result = await executeFile(
      "/tmp/partial-re.txt",
      [
        { oldText: "line1", newText: "LINE1" },
        { oldText: "missing", newText: "MISSING" },
      ],
      {
        readFile: (p) => {
          reads++;
          // First read: original. Second read (post-write re-read): modified bytes.
          if (reads === 1) return files[p] as Buffer;
          return Buffer.from("line1\nline2\nline3\n", "utf-8");
        },
        writeFile: (p, data) => {
          files[p] = data;
        },
        rename: (from, to) => {
          files[to] = files[from] ?? Buffer.alloc(0);
        },
        exists: () => true,
        mutationQueue: async (filePath, fn) => fn(),
      },
    );

    expect(result.isError).toBe(false);
    expect((result.details as any).isPartial).toBe(true);
    expect((result.details as any).postWriteWarnings).toEqual([
      expect.stringContaining("Post-write re-read mismatch"),
    ]);
  });

  it("performs post-write re-read WITHOUT a mutationQueue passthrough", async () => {
    const files: Record<string, Buffer | string> = {
      "/tmp/recheck-noqueue.txt": Buffer.from("line1\nline2\n", "utf-8"),
    };
    let reads = 0;
    const result = await executeFile(
      "/tmp/recheck-noqueue.txt",
      [{ oldText: "line1", newText: "LINE1" }],
      {
        readFile: (p) => {
          reads++;
          if (reads === 1) return files[p] as Buffer;
          // On-disk bytes drifted from what we wrote.
          return Buffer.from("TAMPERED\nline2\n", "utf-8");
        },
        writeFile: (p, data) => {
          files[p] = data;
        },
        rename: (from, to) => {
          files[to] = files[from] ?? Buffer.alloc(0);
        },
        exists: () => true,
      },
    );

    expect(result.isError).toBe(false);
    // Exactly one extra read: the post-write verification itself.
    expect(reads).toBe(2);
    expect((result.details as any).postWriteWarnings).toEqual([
      expect.stringContaining("Post-write re-read mismatch"),
    ]);
  });

  it("re-read also fires on the partial-apply path without a mutationQueue", async () => {
    const files: Record<string, Buffer | string> = {
      "/tmp/recheck-partial-noqueue.txt": Buffer.from("line1\nline2\nline3\n", "utf-8"),
    };
    let reads = 0;
    const result = await executeFile(
      "/tmp/recheck-partial-noqueue.txt",
      [
        { oldText: "line1", newText: "LINE1" },
        { oldText: "missing", newText: "MISSING" },
      ],
      {
        readFile: (p) => {
          reads++;
          if (reads === 1) return files[p] as Buffer;
          return Buffer.from("TAMPERED\nline2\nline3\n", "utf-8");
        },
        writeFile: (p, data) => {
          files[p] = data;
        },
        rename: (from, to) => {
          files[to] = files[from] ?? Buffer.alloc(0);
        },
        exists: () => true,
      },
    );

    expect(result.isError).toBe(false);
    expect((result.details as any).isPartial).toBe(true);
    expect((result.details as any).postWriteWarnings).toEqual([
      expect.stringContaining("Post-write re-read mismatch"),
    ]);
  });

  it("latin1 file with out-of-encoding replacement text does not false-positive the corruption check", async () => {
    // 0xE9 is é in latin1 but invalid utf-8 — forces latin1 detection.
    const files: Record<string, Buffer | string> = {
      "/tmp/latin1-emdash.txt": Buffer.from("caf\xe9 line1\nline2\n", "latin1"),
    };
    let reads = 0;
    const result = await executeFile(
      "/tmp/latin1-emdash.txt",
      [{ oldText: "line2", newText: "ligne deux \u2014 em dash" }],
      {
        readFile: (p) => {
          reads++;
          if (reads === 1) return files[p] as Buffer;
          // The re-read sees exactly the bytes we wrote.
          return files[p] as Buffer;
        },
        writeFile: (p, data) => {
          files[p] = data;
        },
        rename: (from, to) => {
          files[to] = files[from] ?? Buffer.alloc(0);
        },
        exists: () => true,
      },
    );

    expect(result.isError).toBe(false);
    expect((result.details as any).encoding).toBe("latin1");
    expect(reads).toBe(2);
    expect((result.details as any).postWriteWarnings).toEqual([]);
  });

  it("skips coherence warnings when coherenceCheckEnabled is false", async () => {
    const files: Record<string, Buffer | string> = {
      "/tmp/coherence-off.txt": Buffer.from("line1\nline2\n", "utf-8"),
    };
    const result = await executeFile(
      "/tmp/coherence-off.txt",
      [{ oldText: "line1", newText: "         LINE1" }],
      {
        readFile: (p) => files[p] as Buffer,
        writeFile: (p, data) => {
          files[p] = data;
        },
        rename: (from, to) => {
          files[to] = files[from] ?? Buffer.alloc(0);
        },
        exists: () => true,
        coherenceCheckEnabled: false,
      },
    );

    expect(result.isError).toBe(false);
    expect((result.details as any).coherenceWarnings).toEqual([]);
  });

  it("runs coherence warnings when coherenceCheckEnabled is true", async () => {
    const files: Record<string, Buffer | string> = {
      "/tmp/coherence-on.txt": Buffer.from("line1\nline2\n", "utf-8"),
    };
    const result = await executeFile(
      "/tmp/coherence-on.txt",
      [{ oldText: "line1", newText: "         LINE1" }],
      {
        readFile: (p) => files[p] as Buffer,
        writeFile: (p, data) => {
          files[p] = data;
        },
        rename: (from, to) => {
          files[to] = files[from] ?? Buffer.alloc(0);
        },
        exists: () => true,
        coherenceCheckEnabled: true,
      },
    );

    expect(result.isError).toBe(false);
    expect((result.details as any).coherenceWarnings.length).toBeGreaterThan(0);
  });
});
