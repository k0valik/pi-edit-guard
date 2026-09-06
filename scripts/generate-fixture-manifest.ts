#!/usr/bin/env node
/**
 * Generate fixture manifest from the files directory.
 * Run this after adding/modifying fixture files to update MANIFEST.json.
 */

import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "tests", "integration", "fixtures", "files");
const manifestPath = join(fixturesDir, "MANIFEST.json");

interface FileManifest {
  id: string;
  filename: string;
  language: string;
  size_bytes: number;
  primary_targets: string[];
  secondary_targets: string[];
  failure_probability: "low" | "medium" | "high";
  notes: string;
}

interface Manifest {
  manifest_version: string;
  generated: string;
  description: string;
  files: FileManifest[];
  total_files: number;
  total_size_bytes: number;
  recommended_edit_operations: string[];
}

function detectLanguage(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript",
    js: "javascript",
    mjs: "javascript",
    py: "python",
    sh: "bash",
    json: "json",
    md: "markdown",
    txt: "text",
    yaml: "yaml",
    yml: "yaml",
  };
  return map[ext || ""] || "unknown";
}

function generateId(filename: string): string {
  const match = filename.match(/^(\d+)/);
  return match ? match[1] : String(files.length + 1).padStart(2, "0");
}

const files = readdirSync(fixturesDir)
  .filter((f) => !f.startsWith(".") && f !== "MANIFEST.json" && f !== "README.md")
  .sort();

const manifest: Manifest = {
  manifest_version: "1.0.0",
  generated: new Date().toISOString(),
  description: "Integration test fixture manifest for edit tool failure replay",
  files: files.map((filename, _index) => {
    const filePath = join(fixturesDir, filename);
    const stats = statSync(filePath);
    const id = generateId(filename);

    return {
      id,
      filename,
      language: detectLanguage(filename),
      size_bytes: stats.size,
      primary_targets: [],
      secondary_targets: [],
      failure_probability: "medium",
      notes: "Auto-generated entry. Update with specific targets and notes.",
    };
  }),
  total_files: files.length,
  total_size_bytes: files.reduce((sum, f) => sum + statSync(join(fixturesDir, f)).size, 0),
  recommended_edit_operations: [
    "Change section headers",
    "Add new sections between existing ones",
    "Modify code blocks",
    "Fix indentation",
    "Add imports",
    "Rename variables",
    "Update configuration values",
    "Modify function signatures",
    "Add error handling",
    "Change string values",
    "Update comments",
    "Modify JSON values",
    "Change SQL queries",
    "Update template literals",
    "Modify shell commands",
  ],
};

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`Generated manifest: ${manifestPath}`);
console.log(`Files: ${manifest.total_files}`);
console.log(`Total size: ${manifest.total_size_bytes} bytes`);
