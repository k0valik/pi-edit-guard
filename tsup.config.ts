import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/extension.ts" },
  format: ["esm"],
  outDir: "dist",
  bundle: true,
  splitting: false,
  dts: false,
  clean: true,
  treeshake: true,
  sourcemap: false,
  minify: true,
  external: [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-tui",
    "@earendil-works/pi-ai",
    "typebox",
    "@sinclair/typebox",
  ],
});
