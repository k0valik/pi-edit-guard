import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        name: "pi-extension-template",
        test: {
          include: ["tests/**/*.test.ts"],
        },
      },
      {
        name: "pi-base",
        test: {
          include: ["packages/pi-base/src/**/*.test.ts", "packages/pi-base/tests/**/*.test.ts"],
        },
      },
    ],
    silent: true,
    testTimeout: 15000,
  },
});
