// Path resolution — single source of truth for resolveToCwd.
//
// Ported VERBATIM from @earendil-works/pi-coding-agent
// (dist/utils/paths.js + dist/core/tools/path-utils.js). Not re-exported from
// the package root and blocked by the exports map, so upstream source is
// ground truth.

import { homedir } from "node:os";
import { isAbsolute, join, resolve as nodeResolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function normalizePath(
  input: string,
  options: {
    trim?: boolean;
    normalizeUnicodeSpaces?: boolean;
    stripAtPrefix?: boolean;
    expandTilde?: boolean;
    homeDir?: string;
  } = {},
): string {
  let normalized = options.trim ? input.trim() : input;
  if (options.normalizeUnicodeSpaces) {
    normalized = normalized.replace(UNICODE_SPACES, " ");
  }
  if (options.stripAtPrefix && normalized.startsWith("@")) {
    normalized = normalized.slice(1);
  }
  if (options.expandTilde ?? true) {
    const home = options.homeDir ?? homedir();
    if (normalized === "~") return home;
    if (
      normalized.startsWith("~/") ||
      (process.platform === "win32" && normalized.startsWith("~\\"))
    ) {
      return join(home, normalized.slice(2));
    }
  }
  if (normalized.startsWith("file://")) {
    return fileURLToPath(normalized);
  }
  return normalized;
}

function resolvePath(
  input: string,
  baseDir = process.cwd(),
  options: { normalizeUnicodeSpaces?: boolean; stripAtPrefix?: boolean } = {},
): string {
  const normalized = normalizePath(input, options);
  const normalizedBaseDir = normalizePath(baseDir);
  return isAbsolute(normalized)
    ? nodeResolvePath(normalized)
    : nodeResolvePath(normalizedBaseDir, normalized);
}

/**
 * Resolve a path relative to the given cwd. Handles ~ expansion, unicode
 * space normalization, @-prefix stripping, and file:// URLs. Verbatim port of
 * pi's `resolveToCwd` (path-utils.js).
 */
export function resolveToCwd(filePath: string, cwd: string): string {
  return resolvePath(filePath, cwd, {
    normalizeUnicodeSpaces: true,
    stripAtPrefix: true,
  });
}
