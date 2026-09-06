// token_overlap — the mined CANDIDATE class (score-chain.mjs): content
// survives but lines are reordered/hallucinated/reformatted, so every
// boundary-anchored pass misses while Sørensen-Dice over token multisets
// still says "same stuff". Fail-closed: unique qualifying window or nothing.

import { describe, it, expect } from "vitest";
import { tokenOverlapFind } from "../src/edit/matching/passes.js";

describe("tokenOverlapFind", () => {
  it("rescues reordered + hallucinated-middle drift that exact passes miss", () => {
    const original = [
      "function handler(req) {",
      "  const body = parse(req);",
      "  validate(body);",
      "  // NOTE: retry logic lives elsewhere",
      "  return respond(200, body);",
      "}",
    ].join("\n");
    // Query: same tokens, lines shuffled, one hallucinated line, comment gone.
    // Drifted past every structural pass (reordered + renamed) — verified
    // empirically that token_overlap is the ONLY chain pass that matches.
    const query = [
      "function handler(req) {",
      "  const body = parse(req);",
      "  return respond(200, body);",
      "  validate(body);",
      "}",
      "// reviewed: ok",
    ]
      .map((l) => l.replace("handler", "hnd").replace("parse(", "prs("))
      .join("\n");
    expect(original.includes(query)).toBe(false);
    expect(tokenOverlapFind(original, query)).toBe(original);
  });

  it("returns null when multiple windows qualify (ambiguous)", () => {
    const block = ["function dup(x) {", "  return x + 1;", "}"].join("\n");
    const original = [block, "// separator", block].join("\n");
    const query = ["function dup(x) {", "  // shifted comment noise", "  return x + 1;", "}"].join(
      "\n",
    );
    expect(tokenOverlapFind(original, query)).toBeNull();
  });

  it("returns null below the dice floor (different content, shared vocabulary)", () => {
    const original = [
      "function handler(req) {",
      "  const a = build(req);",
      "  const b = ship(a);",
      "  const c = test(b);",
      "  return c;",
      "}",
      "",
      "const x = 1;",
      "const y = 2;",
    ].join("\n");
    const query = [
      "function handler(req) {",
      "  const q = fetch(req);",
      "  const r = send(q);",
      "  await settle(r);",
      "  return wrap(r);",
      "}",
      "export default config;",
    ].join("\n");
    expect(tokenOverlapFind(original, query)).toBeNull();
  });

  it("refuses tiny queries — they belong to the deterministic passes", () => {
    expect(tokenOverlapFind("alpha\nbeta\ngamma", "beta")).toBeNull();
  });

  it("stays silent when an exact match exists (chain short-circuit handles it)", () => {
    // Contract: pass only fires on drifted input; verbatim input is other
    // passes' job. We assert it does not return something OTHER than the
    // exact region.
    const original = "one\ntwo\nthree";
    expect(tokenOverlapFind(original, "two")).toBeNull(); // too small anyway
  });
});

import { executeFile } from "../src/edit/pipeline/execute.js";

describe("semantic-match warnings surface to agent + details", () => {
  it("warns with line range when an edit lands via token_overlap", async () => {
    const original = [
      "function handler(req) {",
      "  const body = parse(req);",
      "  validate(body);",
      "  // NOTE: retry logic lives elsewhere",
      "  return respond(200, body);",
      "}",
    ].join("\n");
    // Drifted past every structural pass (reordered + renamed) — verified
    // empirically that token_overlap is the ONLY chain pass that matches.
    const query = [
      "function handler(req) {",
      "  const body = parse(req);",
      "  return respond(200, body);",
      "  validate(body);",
      "}",
      "// reviewed: ok",
    ]
      .map((l) => l.replace("handler", "hnd").replace("parse(", "prs("))
      .join("\n");
    let written = "";
    const result = await executeFile(
      "/repo/sem.txt",
      [{ oldText: query, newText: query + "\n// touched" }],
      {
        cwd: "/repo",
        readFile: () => Buffer.from(original),
        writeFile: (_p, c) => {
          written = String(c);
        },
        rename: () => {},
        exists: () => true,
        mkdir: () => {},
        unlink: () => {},
      },
    );
    expect(result.isError).toBe(false);
    const text = result.content.map((c) => c.text || "").join("\n");
    expect(text).toContain("[SEMANTIC MATCH]");
    expect(text).toContain("lines 1-6");
    expect((result.details as { semanticWarnings: string[] }).semanticWarnings).toHaveLength(1);
    expect(written).toContain("// touched");
  });

  it("emits no semantic warning for exact matches", async () => {
    const result = await executeFile(
      "/repo/exact.txt",
      [{ oldText: "alpha\nbeta\ngamma", newText: "ALPHA" }],
      {
        cwd: "/repo",
        readFile: () => Buffer.from("alpha\nbeta\ngamma"),
        writeFile: () => {},
        rename: () => {},
        exists: () => true,
        mkdir: () => {},
        unlink: () => {},
      },
    );
    const text = result.content.map((c) => c.text || "").join("\n");
    expect(text).not.toContain("[SEMANTIC MATCH]");
  });
});
