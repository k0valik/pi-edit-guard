import { describe, expect, it } from "vitest";
import { fastHash } from "../src/hash.js";

describe("fastHash", () => {
  it("returns deterministic hash for a string", () => {
    expect(fastHash("hello")).toBe(2821698721);
    expect(fastHash("world")).toBeGreaterThan(0);
    expect(fastHash("hello")).toBe(fastHash("hello"));
  });

  it("returns different hashes for different inputs", () => {
    expect(fastHash("a")).not.toBe(fastHash("b"));
    expect(fastHash("")).not.toBe(fastHash("x"));
  });

  it("returns unsigned 32-bit integer", () => {
    const hash = fastHash("test");
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBeLessThan(2 ** 32);
  });

  it("produces expected known values", () => {
    // Pre-computed with FNV-1a constants 2166136261 / 16777619
    expect(fastHash("")).toBe(2166136261);
    expect(fastHash("test")).toBe(2292920316);
  });
});
