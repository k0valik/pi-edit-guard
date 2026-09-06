import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, afterAll } from "vitest";
import { executeFile } from "../src/edit/pipeline/execute.js";

const sandbox = join(tmpdir(), "pi-better-toolcalls-repro");

function writeFile(filePath: string, content: string | Buffer<ArrayBufferLike>): void {
  require("node:fs").writeFileSync(filePath, content);
}

afterAll(() => {
  try {
    const { rmSync } = require("node:fs");
    rmSync(sandbox, { recursive: true, force: true });
  } catch {}
});

describe("repro: user-observed false positives", () => {
  it("does NOT warn for the edit-tool.ts move of failedDiagnostics block", async () => {
    const original = [
      "        for (const diag of diagnostics) {",
      '          if (diag.status === "noop") {',
      '            const reason = diag.reason ?? "edit did nothing";',
      "            warnings.push(`- edits[${diag.index}]: noop (${reason})`);",
      "          }",
      "        }",
      "        if (isPartial) {",
      "          warnings.push(",
      "            `[PARTIAL APPLY] Applied ${partialAppliedCount} of ${edits.length} edits in ${path}.`,",
      "          );",
      "          for (const diag of failedDiagnostics) {",
      "            const reason = diag.reason ?? diag.status;",
      "            warnings.push(`  edits[${diag.index}]: ${diag.status} (${reason})`);",
      "          }",
      "          if (partialEditsApplied.length > 0) {",
      '            warnings.push(`Applied edits: ${partialEditsApplied.join(", ")}`);',
      "          }",
      "        }",
      "        for (const note of feedback?.notes ?? []) {",
      "          warnings.push(`<repair_note>${note}</repair_note>`);",
      "        }",
      "        if (warnings.length > 0) {",
      "",
    ].join("\n");
    const oldText = [
      "          for (const diag of failedDiagnostics) {",
      "            const reason = diag.reason ?? diag.status;",
      "            warnings.push(`  edits[${diag.index}]: ${diag.status} (${reason})`);",
      "          }",
      "          if (partialEditsApplied.length > 0) {",
      '            warnings.push(`Applied edits: ${partialEditsApplied.join(", ")}`);',
      "          }",
      "        }",
      "\n",
    ].join("\n");
    const newText = [
      "        for (const diag of failedDiagnostics) {",
      "          const reason = diag.reason ?? diag.status;",
      "          warnings.push(`- edits[${diag.index}]: ${diag.status} (${reason})`);",
      "        }",
      "        if (isPartial) {",
      "          warnings.push(",
      "            `[PARTIAL APPLY] Applied ${partialAppliedCount} of ${edits.length} edits in ${path}.`,",
      "          );",
      "          if (partialEditsApplied.length > 0) {",
      '            warnings.push(`Applied edits: ${partialEditsApplied.join(", ")}`);',
      "          }",
      "        }",
      "\n",
    ].join("\n");
    const file = join(sandbox, "edit-tool-false-positive.txt");
    const result = await executeFile(file, [{ oldText, newText }], {
      readFile: () => Buffer.from(original),
      writeFile,
    });
    expect(result.isError).toBe(false);
    expect((result.details as { corruptionWarnings?: string[] }).corruptionWarnings ?? []).toEqual(
      expect.not.arrayContaining([expect.stringMatching(/CORRUPTION CHECK/)]),
    );
  });

  it("does NOT warn for the env.ts addition of warningsEnabled", async () => {
    const original = String.raw`    overwriteGuardEnabled: envBool(
      "EDIT_GUARD_OVERWRITE_GUARD_ENABLED",
      DEFAULTS.overwriteGuardEnabled,
    ),
  };
}
`;
    const file = join(sandbox, "env-false-positive.txt");
    const result = await executeFile(
      file,
      [
        {
          oldText:
            String.raw`    overwriteGuardEnabled: envBool(
      "EDIT_GUARD_OVERWRITE_GUARD_ENABLED",
      DEFAULTS.overwriteGuardEnabled,
    ),
  };
}
` + "\n",
          newText:
            String.raw`    overwriteGuardEnabled: envBool(
      "EDIT_GUARD_OVERWRITE_GUARD_ENABLED",
      DEFAULTS.overwriteGuardEnabled,
    ),
    warningsEnabled: envBool("EDIT_GUARD_WARNINGS_ENABLED", DEFAULTS.warningsEnabled),
  };
}
` + "\n",
        },
      ],
      { readFile: () => Buffer.from(original), writeFile },
    );
    expect(result.isError).toBe(false);
    expect((result.details as { corruptionWarnings?: string[] }).corruptionWarnings ?? []).toEqual(
      expect.not.arrayContaining([expect.stringMatching(/CORRUPTION CHECK/)]),
    );
  });

  it("does NOT warn for the settings.ts addition of warningsEnabled", async () => {
    const original = String.raw`    overwriteGuardEnabled:
      typeof raw.overwriteGuardEnabled === "boolean"
        ? raw.overwriteGuardEnabled
        : DEFAULTS.overwriteGuardEnabled,
  }),
  fields: (cfg) => [
`;
    const file = join(sandbox, "settings-false-positive.txt");
    const result = await executeFile(
      file,
      [
        {
          oldText:
            String.raw`    overwriteGuardEnabled:
      typeof raw.overwriteGuardEnabled === "boolean"
        ? raw.overwriteGuardEnabled
        : DEFAULTS.overwriteGuardEnabled,
  }),
  fields: (cfg) => [
` + "\n",
          newText:
            String.raw`    overwriteGuardEnabled:
      typeof raw.overwriteGuardEnabled === "boolean"
        ? raw.overwriteGuardEnabled
        : DEFAULTS.overwriteGuardEnabled,
    warningsEnabled:
      typeof raw.warningsEnabled === "boolean" ? raw.warningsEnabled : DEFAULTS.warningsEnabled,
  }),
  fields: (cfg) => [
` + "\n",
        },
      ],
      { readFile: () => Buffer.from(original), writeFile },
    );
    expect(result.isError).toBe(false);
    expect((result.details as { corruptionWarnings?: string[] }).corruptionWarnings ?? []).toEqual(
      expect.not.arrayContaining([expect.stringMatching(/CORRUPTION CHECK/)]),
    );
  });
});
