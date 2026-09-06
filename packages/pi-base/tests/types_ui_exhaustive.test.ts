import { describe, expect, it } from "vitest";
import { isRecord } from "../src/types.js";
import { bgRGB, ESC, fgRGB } from "../src/ui.js";

describe("types and UI exhaustive", () => {
  describe("isRecord", () => {
    it("should return true for plain objects", () => {
      expect(isRecord({})).toBe(true);
      expect(isRecord({ a: 1 })).toBe(true);
      expect(isRecord(Object.create(null))).toBe(true);
    });

    it("should return false for null and undefined", () => {
      expect(isRecord(null)).toBe(false);
      expect(isRecord(undefined)).toBe(false);
    });

    it("should return false for arrays", () => {
      expect(isRecord([])).toBe(false);
      expect(isRecord([1, 2, 3])).toBe(false);
    });

    it("should return false for primitives", () => {
      expect(isRecord("string")).toBe(false);
      expect(isRecord(42)).toBe(false);
      expect(isRecord(true)).toBe(false);
      expect(isRecord(Symbol("foo"))).toBe(false);
      expect(isRecord(10n)).toBe(false);
    });

    it("should return true for built-in objects that are not arrays", () => {
      // isRecord implementation: typeof value === "object" && value !== null && !Array.isArray(value)
      expect(isRecord(new Date())).toBe(true);
      expect(isRecord(new Map())).toBe(true);
      expect(isRecord(new Set())).toBe(true);
      expect(isRecord(Buffer.from("foo"))).toBe(true);
      expect(isRecord(new Uint8Array())).toBe(true);
    });

    it("should handle proxies and objects with getters", () => {
      const target = { a: 1 };
      const proxy = new Proxy(target, {});
      expect(isRecord(proxy)).toBe(true);

      const objWithGetter = {
        get a() {
          return 1;
        },
      };
      expect(isRecord(objWithGetter)).toBe(true);
    });
  });

  describe("UI RGB helpers", () => {
    it("should handle standard RGB values", () => {
      expect(fgRGB([255, 128, 0])).toBe(`${ESC}[38;2;255;128;0m`);
      expect(bgRGB([0, 64, 255])).toBe(`${ESC}[48;2;0;64;255m`);
    });

    it("should handle out-of-range RGB values by passing them through", () => {
      // The implementation does not clamp, it just interpolates
      expect(fgRGB([300, -10, 500])).toBe(`${ESC}[38;2;300;-10;500m`);
    });
  });
});
