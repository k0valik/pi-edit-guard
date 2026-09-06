import { describe, expect, it, vi } from "vitest";
import { getExtensionsDir } from "../src/config.js";
import {
  isAlacritty,
  isGhostty,
  isIterm,
  isKitty,
  isTmux,
  isWindowsTerminal,
  isWSL,
} from "../src/env.js";
import { getPiAgentDir } from "../src/paths.js";

describe("pi-base paths and env", () => {
  describe("paths", () => {
    it("should return agent dir", () => {
      vi.stubEnv("PI_CODING_AGENT_DIR", "/tmp/pi");
      expect(getPiAgentDir()).toBe("/tmp/pi");
      vi.unstubAllEnvs();
    });

    it("should return extensions dir", () => {
      vi.stubEnv("PI_CODING_AGENT_DIR", "/tmp/pi");
      expect(getExtensionsDir()).toBe("/tmp/pi/extensions");
      vi.unstubAllEnvs();
    });
  });

  describe("env", () => {
    it("should detect tmux", () => {
      vi.stubEnv("TMUX", "/tmp/tmux-1000/default,123,0");
      expect(isTmux()).toBe(true);
      vi.stubEnv("TMUX", "");
      expect(isTmux()).toBe(false);
      vi.unstubAllEnvs();
    });

    it("should detect kitty", () => {
      vi.stubEnv("KITTY_WINDOW_ID", "1");
      expect(isKitty()).toBe(true);
      vi.unstubAllEnvs();
    });

    it("should detect ghostty", () => {
      vi.stubEnv("TERM_PROGRAM", "ghostty");
      expect(isGhostty()).toBe(true);
      vi.unstubAllEnvs();
    });

    it("should detect iterm", () => {
      vi.stubEnv("TERM_PROGRAM", "iTerm.app");
      expect(isIterm()).toBe(true);
      vi.unstubAllEnvs();
    });

    it("should detect windows terminal", () => {
      vi.stubEnv("WT_SESSION", "abc");
      expect(isWindowsTerminal()).toBe(true);
      vi.unstubAllEnvs();
    });

    it("should detect wsl", () => {
      vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
      expect(isWSL()).toBe(true);
      vi.unstubAllEnvs();
    });

    it("should detect alacritty", () => {
      vi.stubEnv("TERM", "alacritty");
      expect(isAlacritty()).toBe(true);
      vi.unstubAllEnvs();
    });
  });
});
