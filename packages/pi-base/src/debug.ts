import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getExtensionsDir } from "./config.js";

/**
 * Log a structured event to a debug JSONL file in the extension's directory.
 * File path: ~/.pi/agent/extensions/<packageName>-debug.jsonl
 *
 * Implements a self-healing write strategy: attempts direct write to appendFileSync,
 * and only on ENOENT error does it create the directory recursively. This ensures
 * robust logging if directories are deleted during execution, avoids redundant check/create
 * operations in memory/on disk, and eliminates static Set directory tracking.
 *
 * @param packageName The name of the package (e.g., "pi-session-name")
 * @param event The event name or message
 * @param data Optional structured data to include
 */
export function logToDebugFile(packageName: string, event: string, data?: unknown): void {
  const dir = getExtensionsDir();
  const filename = `${packageName}-debug.jsonl`;
  const path = join(dir, filename);

  const now = new Date();
  const timestamp = now.toISOString();
  const msSinceEpoch = now.getTime();

  const entry = {
    timestamp,
    msSinceEpoch,
    event,
    data,
  };
  const line = `${safeStringify(entry)}\n`;

  try {
    appendFileSync(path, line, "utf-8");
  } catch (error: any) {
    if (error && error.code === "ENOENT") {
      try {
        mkdirSync(dir, { recursive: true });
        appendFileSync(path, line, "utf-8");
      } catch (retryError) {
        console.warn(
          `[pi-base] Failed to self-heal and log to debug file for ${packageName}:`,
          retryError,
        );
      }
    } else {
      // Fail silently to avoid crashing the agent due to logging issues
      console.warn(`[pi-base] Failed to log to debug file for ${packageName}:`, error);
    }
  }
}

function safeStringify(obj: unknown): string {
  const cache = new Set();
  return JSON.stringify(obj, (_key, value) => {
    if (typeof value === "object" && value !== null) {
      if (cache.has(value)) {
        return "[Circular]";
      }
      cache.add(value);
    }
    if (value instanceof Error) {
      return {
        message: value.message,
        stack: value.stack,
        name: value.name,
      };
    }
    return value;
  });
}
