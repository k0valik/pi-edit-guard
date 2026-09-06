import { describe, expect, it } from "vitest";
import { bgRGB, ESC, fgRGB, RESET } from "../src/ui.js";

describe("pi-base UI helpers", () => {
  it("should generate fg RGB escape codes", () => {
    expect(fgRGB([255, 0, 0])).toBe(`${ESC}[38;2;255;0;0m`);
  });

  it("should generate bg RGB escape codes", () => {
    expect(bgRGB([0, 255, 0])).toBe(`${ESC}[48;2;0;255;0m`);
  });

  it("should have RESET constant", () => {
    expect(RESET).toBe("\x1b[0m");
  });
});
