import { execSync } from "node:child_process";

const packages = [
  { name: "pi-base", config: "packages/pi-base/tsup.config.ts" },
  { name: "extension", config: "tsup.config.ts" },
];

for (const pkg of packages) {
  console.log(`Building ${pkg.name}...`);
  try {
    execSync(`pnpm exec tsup --config ${pkg.config}`, {
      stdio: "inherit",
    });
  } catch (error) {
    console.error(`Failed to build ${pkg.name}:`, error);
    process.exit(1);
  }
}
