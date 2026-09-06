/**
 * Preflight — path validation and normalization before tool execution.
 *
 * For writes: ensures parent dir exists, then advisory-gates outside-cwd
 * (non-blocking). For reads/edits: checks existence, suggests near-matches
 * ("did you mean …?") on miss. Also handles alias renames (file_path →
 * path) and quote/whitespace stripping via normalizePathValue. Ownership:
 * the hook (platform/hooks/preflight.ts) mutates event.input in place.
 */

import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { mkdirSync } from "node:fs";
import { getPathArg, normalizePathValue, pathExists, PATH_TOOLS } from "./paths.js";
import { nearMatches } from "./suggest.js";

export type PathRepair =
  | { kind: "renamed"; aliasKey: string; value: string }
  | { kind: "normalized"; key: string; value: string };

export type PreflightOutcome =
  | { kind: "pass" }
  | PathRepair
  | { kind: "block"; reason: string }
  // Advisory may co-occur with a repair (alias rename / quote-whitespace
  // normalization). The caller must apply `repair` even though the advisory
  // itself is non-blocking — otherwise the tool receives the raw malformed
  // path and fails on top of the advisory.
  | { kind: "advisory"; reason: string; repair?: PathRepair };

function isInside(dir: string, filePath: string): boolean {
  const rel = relative(dir, filePath);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Alias-rename / normalization repair for the resolved arg, if any. */
function pathRepair(
  arg: { key: string; value: string },
  normalized: string,
): PathRepair | undefined {
  if (arg.key !== "path") return { kind: "renamed", aliasKey: arg.key, value: normalized };
  return normalized !== arg.value
    ? { kind: "normalized", key: arg.key, value: normalized }
    : undefined;
}

export function preflight(args: {
  toolName: string;
  input: Record<string, unknown>;
  cwd: string;
}): PreflightOutcome {
  const { toolName, input, cwd } = args;
  const arg = getPathArg(toolName, input);
  if (!arg) return { kind: "pass" };

  const normalized = normalizePathValue(arg.value);
  const resolved = resolve(cwd, normalized);
  const meta = PATH_TOOLS[toolName];

  if (meta.isWrite) {
    try {
      mkdirSync(dirname(resolved), { recursive: true });
    } catch {
      return {
        kind: "block",
        reason: `Cannot write to "${arg.value}": failed to create parent directory.`,
      };
    }
    const repair = pathRepair(arg, normalized);
    if (!isInside(cwd, resolved)) {
      return {
        kind: "advisory",
        reason: `Path "${arg.value}" is outside the current working directory (${cwd}).`,
        repair,
      };
    }
    return repair ?? { kind: "pass" };
  }

  if (!pathExists(resolved)) {
    const suggestions = nearMatches(normalized, cwd);
    const tail = suggestions.length
      ? ` Did you mean: ${suggestions.join(", ")}?`
      : ` Use ls or find to locate it before retrying.`;
    return {
      kind: "block",
      reason: `Path "${arg.value}" does not exist relative to ${cwd}.${tail}`,
    };
  }

  const repair = pathRepair(arg, normalized);

  if (!isInside(cwd, resolved)) {
    return {
      kind: "advisory",
      reason: `Path "${arg.value}" is outside the current working directory (${cwd}).`,
      repair,
    };
  }

  // Aliased keys must be renamed even when the value itself is clean:
  // native schema validation requires `path` and rejects everything else.
  return repair ?? { kind: "pass" };
}
