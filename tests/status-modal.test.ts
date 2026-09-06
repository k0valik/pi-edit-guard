/**
 * /edit-guard status modal — tab partitioning, stats ordering, audit
 * rendering, and config projection.
 *
 * Regression root: modal fields previously carried no `tab` id, so the
 * modal's first-tab fallback dumped every group onto Stats while Audit
 * and Config rendered empty.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openSettingsModalMock = vi.fn(async (..._args: unknown[]) => {});

vi.mock("../packages/pi-base/src/index.ts", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, openSettingsModal: (...args: unknown[]) => openSettingsModalMock(...args) };
});

import { createPiMock, makeCtx } from "../packages/pi-base/src/pi-mock.js";
import {
  buildConfigProjectionFields,
  describeAuditEvent,
  registerEditGuardCommand,
} from "../src/platform/commands/edit-guard/index.js";
import { CONFIG_FILENAME, config, getConfig } from "../src/config/settings.js";
import { telemetry } from "../src/telemetry.js";
import type { Field } from "../packages/pi-base/src/index.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

let nextEntryId = 0;

function auditEntry(data: Record<string, unknown>) {
  nextEntryId += 1;
  return {
    type: "custom",
    customType: "edit-guard:event",
    id: `entry-${nextEntryId}`,
    timestamp: 1_756_100_000_000,
    data,
  };
}

const STORMBREAKER_HANDLES = {
  getStats: () => ({
    errorsEnhanced: 7,
    loopsBroken: 2,
    perTool: { bash: { errorsEnhanced: 7, loopsBroken: 2 } },
  }),
};

async function openStatusModal(
  sessionEntries: unknown[] = [],
  stormbreakerHandles?: Parameters<typeof registerEditGuardCommand>[1],
): Promise<{ tabs: Array<{ id: string; label: string }>; fields: Field[] }> {
  openSettingsModalMock.mockClear();
  const pi = createPiMock();
  registerEditGuardCommand(pi as never, stormbreakerHandles);
  const handler = pi.getCommandHandler("edit-guard") as (
    args: string,
    ctx: unknown,
  ) => Promise<void>;
  expect(handler).toBeDefined();
  const ctx = makeCtx({
    sessionManager: { getEntries: () => sessionEntries, getSessionId: () => "s" },
  });
  await handler("", ctx);
  expect(openSettingsModalMock).toHaveBeenCalledTimes(1);
  return openSettingsModalMock.mock.calls[0]![1] as unknown as {
    tabs: Array<{ id: string; label: string }>;
    fields: Field[];
  };
}

// ── Tab partitioning ───────────────────────────────────────────────────────

describe("status modal tab partitioning", () => {
  it("declares the Stats/Audit/Config tab strip", async () => {
    const { tabs } = await openStatusModal();
    expect(tabs.map((t) => t.id)).toEqual(["stats", "audit", "config"]);
    expect(tabs.map((t) => t.label)).toEqual(["Stats", "Audit", "Config"]);
  });

  it("assigns every field an explicit tab id (no first-tab fallback)", async () => {
    const { fields } = await openStatusModal([auditEntry({ type: "edit.applied" })]);
    const untagged = fields.filter((f) => f.tab === undefined);
    expect(untagged).toEqual([]);
  });

  it("keeps each group on its own tab", async () => {
    const { fields } = await openStatusModal([
      auditEntry({ type: "match.pass", passName: "simple" }),
      auditEntry({ type: "stale_read.blocked", path: "/tmp/a.md" }),
    ]);
    const statsKeys = fields.filter((f) => f.tab === "stats").map((f) => f.key);
    const auditKeys = fields.filter((f) => f.tab === "audit").map((f) => f.key);
    const configKeys = fields.filter((f) => f.tab === "config").map((f) => f.key);

    expect(statsKeys.some((k) => k.startsWith("audit-") || k.startsWith("cfg-"))).toBe(false);
    expect(auditKeys.every((k) => k.startsWith("audit-") || k.startsWith("sec-audit"))).toBe(true);
    expect(configKeys.every((k) => k.startsWith("cfg-"))).toBe(true);
    expect(statsKeys).toContain("events");
    expect(statsKeys).not.toContain("sec-audit");
  });
});

// ── Command surface: /edit-guard (status) + /edit-guard:config ─────────────

describe("command registration", () => {
  it("registers status and config as two top-level commands", () => {
    const pi = createPiMock();
    registerEditGuardCommand(pi as never);
    expect(pi.getCommandHandler("edit-guard")).toBeDefined();
    expect(pi.getCommandHandler("edit-guard:config")).toBeDefined();
  });
});

// ── Stats tab ───────────────────────────────────────────────────────────────

describe("status modal stats tab", () => {
  it("orders sections along the guard pipeline", async () => {
    const { fields } = await openStatusModal();
    const sections = fields
      .filter((f) => f.tab === "stats" && f.type === "section")
      .map((f) => (f as { value: string }).value);
    expect(sections).toEqual([
      "Overall",
      "Preflight",
      "Repair",
      "Anchor",
      "Stale-read",
      "Stormbreaker",
      "Closest-candidate",
    ]);
  });

  it("surfaces stormbreaker handle stats", async () => {
    const { fields } = await openStatusModal([], STORMBREAKER_HANDLES);
    const enhanced = fields.find((f) => f.key === "stormEnhanced") as {
      value: string;
    };
    const loops = fields.find((f) => f.key === "stormLoops") as { value: string };
    expect(enhanced.value).toBe("7");
    expect(loops.value).toBe("2");
  });
});

// ── Audit tab ───────────────────────────────────────────────────────────────

const ALL_EVENT_TYPES = [
  "edit.envelope",
  "edit.applied",
  "edit.partial",
  "edit.autopatch",
  "match.pass",
  "match.closest_candidate",
  "match.already_applied",
  "anchor.not_found",
  "anchor.ambiguous",
  "anchor.redundant_dropped",
  "preflight.normalized",
  "preflight.blocked",
  "stale_read.blocked",
  "stale_read.self_healed",
  "write_guard.denied",
  "overwrite_guard.blocked",
  "stormbreaker.enhanced",
  "stormbreaker.loop_broken",
  "stormbreaker.auto_retry",
  "repair.rule",
];

describe("status modal audit tab", () => {
  it("shows an empty-state row when no events exist", async () => {
    const { fields } = await openStatusModal();
    const auditFields = fields.filter((f) => f.tab === "audit");
    expect(auditKeysOf(auditFields)).toContain("audit-empty");
    const section = auditFields.find((f) => f.type === "section") as {
      value: string;
    };
    expect(section.value).toBe("Recent audit");
  });

  it("caps the trail at 25 entries and says so in the section header", async () => {
    const entries = Array.from({ length: 31 }, (_, i) =>
      auditEntry({ type: "edit.applied", editsApplied: i }),
    );
    const { fields } = await openStatusModal(entries);
    const auditFields = fields.filter((f) => f.tab === "audit");

    // header + 25 event rows (newest kept)
    expect(auditFields).toHaveLength(26);
    const section = auditFields.find((f) => f.type === "section") as {
      value: string;
    };
    expect(section.value).toBe("Recent audit — last 25 of 31 events");
    const lastRow = auditFields.at(-1) as { value: string };
    expect(lastRow.value).toContain("30 edits");
  });

  it("documents every event kind with a focused-row hint", async () => {
    const entries = ALL_EVENT_TYPES.map((type) => auditEntry({ type }));
    const { fields } = await openStatusModal(entries);
    const rowsByValue = new Map(
      fields
        .filter((f) => f.tab === "audit" && f.type === "readonly")
        .map((f) => [(f as { value: string }).value, f]),
    );
    for (const type of ALL_EVENT_TYPES) {
      const summary = describeAuditEvent({ type });
      const row = rowsByValue.get(summary) as { hint?: string } | undefined;
      expect(row, `no audit row for ${type}`).toBeDefined();
      expect(row?.hint, `no hint for ${type}`).toBeTruthy();
    }
  });

  it("summarizes stormbreaker.auto_retry with tool, count, and delay", () => {
    expect(
      describeAuditEvent({
        type: "stormbreaker.auto_retry",
        toolName: "edit",
        count: 3,
        delayMs: 3000,
      }),
    ).toBe("auto-retry · edit ×3 (delay 3000ms)");
  });

  it("flattens batched { events: [...] } entries alongside legacy single-event entries", async () => {
    const batched = auditEntry({
      events: [
        { type: "match.pass", passName: "simple", timestamp: 1_756_100_000_100 },
        {
          type: "stormbreaker.auto_retry",
          toolName: "edit",
          count: 3,
          delayMs: 3000,
          timestamp: 1_756_100_000_200,
        },
      ],
    });
    const legacy = auditEntry({
      type: "stale_read.blocked",
      path: "/tmp/a.md",
      timestamp: 1_756_100_000_300,
    });
    const { fields } = await openStatusModal([batched, legacy]);
    const values = fields
      .filter((f) => f.tab === "audit" && f.type === "readonly")
      .map((f) => (f as { value: string }).value);

    // Two batched events + one legacy event = three rows.
    expect(values.some((v) => v.includes("match pass"))).toBe(true);
    expect(values.some((v) => v.includes("auto-retry · edit ×3"))).toBe(true);
    expect(values.some((v) => v.includes("stale-read blocked"))).toBe(true);
    expect(values).toHaveLength(3);
  });

  it("skips malformed events inside a batch instead of rendering garbage rows", async () => {
    const batched = auditEntry({
      events: [
        { type: "match.pass", passName: "simple", timestamp: 1_756_100_000_100 },
        { foo: "bar" }, // object but no `type` discriminator
        null, // not an object
        "match.pass", // wrong type entirely
      ],
    });
    const { fields } = await openStatusModal([batched]);
    const values = fields
      .filter((f) => f.tab === "audit" && f.type === "readonly")
      .map((f) => (f as { value: string }).value);

    // One malformed batch entry must not inject N garbage rows — only the
    // one well-formed event renders.
    expect(values).toHaveLength(1);
    expect(values[0]).toContain("match pass");
  });

  it("flushes pending telemetry before reading the audit trail (flush-on-read)", async () => {
    // Simulate the real write path synchronously, exactly as pi does:
    // flushTelemetry → pi.appendEntry → sessionManager.appendCustomEntry →
    // fileEntries.push (pi's _appendEntry is a sync in-memory push, so
    // getEntries() sees the batch immediately). The audit tab must RENDER
    // the flushed event — asserting only "the handler fired" would not
    // prove the user sees fresh data.
    const sessionEntries: unknown[] = [];
    const flushed: unknown[][] = [];
    telemetry.setFlushHandler((batch) => {
      flushed.push(batch);
      sessionEntries.push({
        type: "custom",
        customType: "edit-guard:event",
        data: { events: batch },
      });
    });
    telemetry.flushNow(); // clear prior noise
    const flushesBefore = flushed.length;

    telemetry.record({
      type: "stormbreaker.enhanced",
      timestamp: 1_756_100_000_000,
      toolName: "edit",
      count: 1,
    });
    expect(telemetry.pendingCount).toBe(1);

    try {
      const { fields } = await openStatusModal(sessionEntries);

      // Exactly one flush since the status call, carrying exactly the
      // seeded event (not "at least one" — that would pass on noise).
      expect(flushed.length).toBe(flushesBefore + 1);
      expect(flushed.at(-1)).toHaveLength(1);

      // End-to-end: the freshly flushed event is rendered in the audit tab.
      const values = fields
        .filter((f) => f.tab === "audit" && f.type === "readonly")
        .map((f) => (f as { value: string }).value);
      expect(values.some((v) => v.includes("error enhanced · edit ×1"))).toBe(true);

      expect(telemetry.pendingCount).toBe(0);
    } finally {
      telemetry.setFlushHandler(() => {});
      telemetry.flushNow();
    }
  });

  it("summarizes event payloads into readable one-liners", async () => {
    expect(
      describeAuditEvent({
        type: "match.pass",
        passName: "simple",
        autoExpand: true,
        anchorUsed: true,
      }),
    ).toBe("match pass · simple · auto-expand · anchor");
    expect(
      describeAuditEvent({
        type: "edit.applied",
        editsApplied: 2,
        anchorUsed: true,
        durationMs: 5,
      }),
    ).toBe("edit applied · 2 edits · anchor · 5 ms");
    expect(describeAuditEvent({ type: "edit.applied", editsApplied: 1, durationMs: 3 })).toBe(
      "edit applied · 1 edit · 3 ms",
    );
    expect(
      describeAuditEvent({ type: "preflight.blocked", toolName: "bash", reason: "missing-file" }),
    ).toBe("path blocked · bash (missing-file)");
    expect(
      describeAuditEvent({ type: "stormbreaker.loop_broken", toolName: "bash", count: 3 }),
    ).toBe("loop broken · bash ×3");
    expect(
      describeAuditEvent({ type: "repair.rule", ruleId: "quote-escape", outcome: "repaired" }),
    ).toBe("repair rule · quote-escape (repaired)");
  });

  it("normalizes tilde paths in event payloads", () => {
    expect(describeAuditEvent({ type: "stale_read.blocked", path: "~/notes/doc.md" })).toBe(
      `stale-read blocked ${join(homedir(), "notes/doc.md")}`,
    );
  });

  it("falls back gracefully for unknown payloads", () => {
    expect(describeAuditEvent({})).toBe("event");
    expect(describeAuditEvent({ type: "future.thing", count: 2, editsApplied: 3 })).toBe(
      "future.thing ×2 (3 edits)",
    );
  });
});

// ── Config tab ──────────────────────────────────────────────────────────────

function formatExpectedValue(field: Field): string {
  switch (field.type) {
    case "boolean":
      return field.value ? "on" : "off";
    case "enum":
      return field.optionLabels?.[field.value] ?? String(field.value);
    case "number":
      return String(field.value);
    case "string":
    case "text":
    case "secret":
    case "path":
      return field.value;
    default:
      return JSON.stringify((field as { value?: unknown }).value);
  }
}

describe("status modal config projection", () => {
  it("projects every declared config field onto a readonly row", () => {
    const rows = buildConfigProjectionFields();
    const declared = config.getFields(getConfig());

    for (const field of declared) {
      if (field.type === "action" || field.type === "custom" || field.type === "section") {
        continue;
      }
      const row = rows.find((r) => r.key === `cfg-${String(field.key)}`) as
        | ((typeof rows)[number] & { value: string })
        | undefined;
      expect(row, `missing projection row for ${String(field.key)}`).toBeDefined();
      expect(row!.label).toBe(field.label);
      expect(row!.value).toBe(formatExpectedValue(field));
      expect(row!.tab).toBe("config");
    }
  });

  it("formats booleans as on/off and enums via option labels", () => {
    const rows = buildConfigProjectionFields();
    const overrideRow = rows.find((r) => r.key === "cfg-editOverrideEnabled") as {
      value: string;
    };
    expect(["on", "off"]).toContain(overrideRow.value);

    const policyRow = rows.find((r) => r.key === "cfg-repairPolicy") as { value: string };
    const policyField = config
      .getFields(getConfig())
      .find((f) => f.key === "repairPolicy") as Extract<Field, { type: "enum" }>;
    expect(policyRow.value).toBe(policyField.optionLabels?.[policyField.value]);
  });

  it("carries descriptions through and ends with file + editing pointer rows", () => {
    const rows = buildConfigProjectionFields();
    const declared = config.getFields(getConfig());
    const withDesc = declared.find((f) => f.description && f.type !== "action")!;

    const projected = rows.find((r) => r.key === `cfg-${String(withDesc.key)}`) as {
      description?: string;
    };
    expect(projected.description).toBe(withDesc.description);

    const last = rows.at(-1)!;
    expect(last.key).toBe("cfg-editPointer");
    expect((last as { value: string }).value).toBe("/edit-guard:config");

    const secondToLast = rows.at(-2)!;
    expect(secondToLast.key).toBe("cfg-configFile");
    expect((secondToLast as { value: string }).value).toBe(CONFIG_FILENAME);
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function auditKeysOf(fields: Field[]): string[] {
  return fields.map((f) => f.key);
}

beforeEach(() => {
  nextEntryId = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});
