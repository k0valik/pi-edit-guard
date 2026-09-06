import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  outDir: "dist",
  bundle: true,
  splitting: false,
  dts: false,
  clean: true,
  treeshake: true,
  sourcemap: false,
  external: [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "@earendil-works/pi-ai",
    "typebox",
  ],
});
