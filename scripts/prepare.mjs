// Best-effort build hook. Runs via `prepare` on install (dev clones, git deps)
// and on pack/publish. Designed to NEVER break a consumer install:
//
//   - tsup present  → build dist/ (real build errors still fail loudly —
//                     that's a dev/CI bug, not a consumer environment issue)
//   - tsup missing  → skip silently. Registry consumers never run this
//                     script at all; git consumers without devDependencies
//                     (pi default `npm install --omit=dev` for git deps) skip
//                     and pi loads `./src/extension.ts` via jiti at startup.
//   - simple-git-hooks present → (re)install git hooks, best-effort (dev checkouts only)
//
// Zero runtime dependencies: plain node, no pnpm/npm/bun requirement.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const isWindows = process.platform === "win32";
const bin = (name) => join(root, "node_modules", ".bin", isWindows ? `${name}.cmd` : name);

// 1. Build dist when the toolchain is available.
// Installer-agnostic: works under pnpm, bun, npm. Pi never calls build after
// install — only `prepare` does. Windows needs shell:true for .cmd shims.
const tsup = bin("tsup");
if (existsSync(tsup)) {
  let r = spawnSync(tsup, [], { cwd: root, stdio: "inherit", shell: isWindows });
  if (r.status !== 0) {
    console.error("[prepare] tsup build failed (tsup.config.ts)");
    process.exit(r.status ?? 1);
  }
  const piBaseConfig = join(root, "packages/pi-base/tsup.config.ts");
  const piBaseDir = join(root, "packages/pi-base");
  if (existsSync(piBaseConfig)) {
    r = spawnSync(tsup, [], { cwd: piBaseDir, stdio: "inherit", shell: isWindows });
    if (r.status !== 0) console.warn(`[prepare] pi-base build skipped: exit ${r.status}`);
  }
}

// 2. Git hooks, best-effort (only meaningful in a dev checkout).
const sgh = bin("simple-git-hooks");
if (existsSync(sgh)) {
  const r = spawnSync(sgh, [], { cwd: root, stdio: "inherit", shell: isWindows });
  if (r.status !== 0) {
    console.warn(`[prepare] simple-git-hooks skipped (non-fatal): exit ${r.status}`);
  }
}
