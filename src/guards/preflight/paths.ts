import { existsSync } from "node:fs";

export interface PathToolMeta {
  /** The path arg is optional (e.g. grep/find/ls default to cwd). */
  optional: boolean;
  /** The tool writes to the path, so the target itself need not pre-exist. */
  isWrite: boolean;
}

/** Built-in tools whose primary path arg can be reality-checked before execution. */
export const PATH_TOOLS: Record<string, PathToolMeta> = {
  read: { optional: false, isWrite: false },
  edit: { optional: false, isWrite: false },
  write: { optional: false, isWrite: true },
  ls: { optional: true, isWrite: false },
  grep: { optional: true, isWrite: false },
  find: { optional: true, isWrite: false },
};

/** Candidate arg names that carry a path, in priority order. */
const PATH_KEYS = ["path", "file_path", "filePath"] as const;

export function getPathArg(
  toolName: string,
  input: Record<string, unknown>,
): { key: string; value: string } | null {
  if (!PATH_TOOLS[toolName]) return null;
  for (const key of PATH_KEYS) {
    const v = input[key];
    if (typeof v === "string" && v.length > 0) return { key, value: v };
  }
  return null;
}

export function normalizePathValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

export function pathExists(resolved: string): boolean {
  return existsSync(resolved);
}
