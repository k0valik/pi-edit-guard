import { execSync } from "node:child_process";

function run(cmd, label) {
  console.log(`\n\x1b[1m▸ ${label}\x1b[0m`);
  try {
    execSync(cmd, { stdio: "inherit" });
  } catch {
    console.error(`\x1b[31m✗ ${label} failed\x1b[0m`);
    process.exit(1);
  }
}

run("pnpm typecheck", "typecheck");
run("pnpm test", "test");
