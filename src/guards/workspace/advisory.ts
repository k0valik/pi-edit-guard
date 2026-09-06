/**
 * Outside-CWD advisory — non-blocking notice for paths outside the workspace.
 *
 * When a tool accesses a path outside cwd, a one-liner is appended to the
 * tool result: "[ADVISORY] This … fell outside the scope of the cwd …".
 * No blocking, no throw. Controlled by `outsideCwdAdvisoryEnabled`. Edit
 * owns its own advisory emission (via getOutsideCwdAdvisory in
 * platform/tools/edit.ts) and telemetry; other tools are advised via the
 * preflight hook (platform/hooks/preflight.ts → ADVISORY_OWNING_TOOLS gate
 * prevents double-counting).
 */

import { isAbsolute, relative, sep } from "node:path";

import { getConfig } from "../../config/settings.js";
import { telemetry } from "../../telemetry.js";

export interface AdvisoryContext {
  cwd: string;
}

export interface AdvisoryOptions {
  toolName: string;
  absolutePath: string;
}

function isInside(dir: string, filePath: string): boolean {
  const rel = relative(dir, filePath);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Tools whose execute() path calls `getOutsideCwdAdvisory()` directly. For
 * these tools, the advisory helper is the SINGLE source of both the advisory
 * text and the `path.advisory` telemetry event — the preflight hook must not
 * record a duplicate (see the ADVISORY_OWNING_TOOLS gate in
 * src/platform/hooks/preflight.ts), otherwise every outside-cwd call
 * double-counts pathAdvisoryCount.
 */
export const ADVISORY_OWNING_TOOLS: ReadonlySet<string> = new Set(["edit"]);

export async function getOutsideCwdAdvisory(
  ctx: AdvisoryContext | undefined,
  opts: AdvisoryOptions,
): Promise<string | undefined> {
  if (!ctx) return undefined;
  const { absolutePath, toolName } = opts;
  if (isInside(ctx.cwd, absolutePath)) return undefined;
  if (!getConfig().outsideCwdAdvisoryEnabled) return undefined;

  telemetry.record({
    type: "path.advisory",
    timestamp: Date.now(),
    toolName,
    path: absolutePath,
  });

  return `[ADVISORY] This ${toolName} fell outside the scope of the cwd. Think briefly if this was intentional, or if a malformed path was used.`;
}
