/**
 * /edit-guard commands — status modal and settings modal.
 *
 * Usage:
 *   /edit-guard          → status (Stats / Audit / Config tabs)
 *   /edit-guard:config   → open ConfigManager settings modal
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { CONFIG_FILENAME, config, refreshConfig } from "../../../config/settings.js";
import { openSettingsModal, type Field } from "../../../../packages/pi-base/src/index.ts";
import { telemetry, type GuardStats } from "../../../telemetry.js";
import { resolveToCwd } from "../../../shared/paths.js";

/** Max audit-trail entries shown on the Audit tab (newest last). */
const AUDIT_LIMIT = 25;

const TAB_STATS = "stats";
const TAB_AUDIT = "audit";
const TAB_CONFIG = "config";

export function registerEditGuardCommand(
  pi: ExtensionAPI,
  stormbreakerHandles?: {
    getStats(): {
      errorsEnhanced: number;
      loopsBroken: number;
      perTool: Record<string, { errorsEnhanced: number; loopsBroken: number }>;
    };
  },
): void {
  pi.registerCommand("edit-guard", {
    description: "Show Edit Guard status (Stats / Audit / Config).",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await handleStatus(ctx, ctx.ui, stormbreakerHandles);
    },
  });

  pi.registerCommand("edit-guard:config", {
    description: "Open Edit Guard settings modal (global / project scopes).",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await handleSettings(ctx);
    },
  });
}

async function handleStatus(
  ctx: ExtensionCommandContext,
  _ui: ExtensionCommandContext["ui"],
  stormbreakerHandles?: {
    getStats(): {
      errorsEnhanced: number;
      loopsBroken: number;
      perTool: Record<string, { errorsEnhanced: number; loopsBroken: number }>;
    };
  },
): Promise<void> {
  const stormStats = stormbreakerHandles?.getStats() ?? {
    errorsEnhanced: 0,
    loopsBroken: 0,
    perTool: {},
  };

  // Config tab — read-only projection of the declared config surface
  // (same field definitions /edit-guard:config renders). Editing stays
  // in the buffered settings modal, which owns global/project scopes.
  const configFields = buildConfigProjectionFields();

  // Flush-on-read: drain pending telemetry into the session log so the
  // audit tab reflects events recorded since the last lifecycle checkpoint.
  // stats() reads in-memory counters and is always fresh regardless.
  telemetry.flushNow();

  const stats = telemetry.stats();
  const statsFields = buildStatsFields(stats, stormStats);
  const auditFields = buildAuditFields(ctx);

  await openSettingsModal(ctx, {
    title: "Edit Guard — Status",
    tabs: [
      { id: TAB_STATS, label: "Stats" },
      { id: TAB_AUDIT, label: "Audit" },
      { id: TAB_CONFIG, label: "Config" },
    ],
    initialTab: TAB_STATS,
    enableSearch: true,
    fields: [...statsFields, ...auditFields, ...configFields],
    mode: "immediate",
    onChange: () => undefined,
  });
}

/**
 * Build the read-only Stats-tab fields. Sections follow the guard pipeline:
 * preflight → repair → anchor/matching → stale-read → stormbreaker → diagnostics.
 */
function buildStatsFields(
  stats: GuardStats,
  stormStats: {
    errorsEnhanced: number;
    loopsBroken: number;
    perTool: Record<string, { errorsEnhanced: number; loopsBroken: number }>;
  },
): Field[] {
  const fields: Field[] = [];

  fields.push({
    key: "sec-overall",
    type: "section",
    label: "",
    value: "Overall",
  });
  fields.push({
    key: "events",
    type: "readonly",
    label: "Events recorded",
    value: String(stats.eventsRecorded),
  });
  fields.push({
    key: "editsApplied",
    type: "readonly",
    label: "Edits applied",
    value: String(stats.editsApplied),
  });
  fields.push({
    key: "editsByPass",
    type: "readonly",
    label: "Edits per pass",
    value: formatTopN(stats.editsAppliedByPass),
  });
  fields.push({
    key: "meanDuration",
    type: "readonly",
    label: "Mean edit duration",
    value: `${stats.meanEditDurationMs} ms`,
  });

  fields.push({
    key: "sec-preflight",
    type: "section",
    label: "",
    value: "Preflight",
  });
  fields.push({
    key: "preflightNormalized",
    type: "readonly",
    label: "Path normalized",
    value: String(stats.preflightNormalized),
  });
  fields.push({
    key: "preflightBlocked",
    type: "readonly",
    label: "Path blocked",
    value: String(stats.preflightBlocked),
  });
  fields.push({
    key: "pathAdvisory",
    type: "readonly",
    label: "Outside-cwd advisories",
    value: String(stats.pathAdvisoryCount),
  });

  fields.push({
    key: "sec-repair",
    type: "section",
    label: "",
    value: "Repair",
  });
  fields.push({
    key: "repairRules",
    type: "readonly",
    label: "Repair rules fired",
    value: formatTopN(stats.repairRules),
  });

  fields.push({
    key: "sec-anchor",
    type: "section",
    label: "",
    value: "Anchor",
  });
  fields.push({
    key: "anchorUsed",
    type: "readonly",
    label: "Anchor used",
    value: String(stats.anchorUsed),
  });
  fields.push({
    key: "anchorNotFound",
    type: "readonly",
    label: "Anchor not found",
    value: String(stats.anchorNotFound),
  });
  fields.push({
    key: "anchorAmbiguous",
    type: "readonly",
    label: "Anchor ambiguous",
    value: String(stats.anchorAmbiguous),
  });
  fields.push({
    key: "autoExpand",
    type: "readonly",
    label: "Auto-expanded",
    value: String(stats.autoExpand),
  });

  fields.push({
    key: "sec-stale",
    type: "section",
    label: "",
    value: "Stale-read",
  });
  fields.push({
    key: "staleReadBlocked",
    type: "readonly",
    label: "Blocked",
    value: String(stats.staleReadBlocked),
  });
  fields.push({
    key: "staleReadSelfHealed",
    type: "readonly",
    label: "Self-healed",
    value: String(stats.staleReadSelfHealed),
  });

  fields.push({
    key: "sec-storm",
    type: "section",
    label: "",
    value: "Stormbreaker",
  });
  fields.push({
    key: "stormEnhanced",
    type: "readonly",
    label: "Errors enhanced",
    value: String(stormStats.errorsEnhanced),
  });
  fields.push({
    key: "stormLoops",
    type: "readonly",
    label: "Loops broken",
    value: String(stormStats.loopsBroken),
  });
  const perTool = Object.entries(stormStats.perTool);
  if (perTool.length > 0) {
    fields.push({
      key: "stormPerTool",
      type: "readonly",
      label: "Per-tool",
      value: perTool
        .sort(
          (a, b) =>
            b[1].errorsEnhanced + b[1].loopsBroken - (a[1].errorsEnhanced + a[1].loopsBroken),
        )
        .map(([tool, s]) => `${tool}: ${s.errorsEnhanced}e/${s.loopsBroken}b`)
        .join(", "),
    });
  }

  fields.push({
    key: "sec-closest",
    type: "section",
    label: "",
    value: "Closest-candidate",
  });
  fields.push({
    key: "closestCount",
    type: "readonly",
    label: "Candidates",
    value: String(stats.closestCandidateCount),
  });
  fields.push({
    key: "closestMean",
    type: "readonly",
    label: "Mean similarity",
    value: String(stats.meanClosestSimilarity),
  });

  return fields.map((f) => ({ ...f, tab: TAB_STATS }));
}

/** Format a Record<string, number> as a compact "top N" summary string. */
function formatTopN(map: Record<string, number>, n = 3): string {
  const entries = Object.entries(map);
  if (entries.length === 0) return "(none)";
  return entries
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k}×${v}`)
    .join(", ");
}

/** Project the ConfigManager's declared fields onto read-only Config-tab rows. */
export function buildConfigProjectionFields(): Field[] {
  const declared = config
    .getFields(config.load())
    .filter((f) => f.type !== "action" && f.type !== "custom" && f.type !== "section");

  const rows: Field[] = declared.map((field) => ({
    key: `cfg-${String(field.key)}`,
    type: "readonly",
    tab: TAB_CONFIG,
    label: field.label,
    description: field.description,
    value: formatConfigValue(field),
  }));
  rows.push({
    key: "cfg-configFile",
    type: "readonly",
    tab: TAB_CONFIG,
    label: "Config file",
    value: CONFIG_FILENAME,
    hint: "Layered resolution: defaults ← global ← project-local (.pi) ← env vars.",
  });
  rows.push({
    key: "cfg-editPointer",
    type: "readonly",
    tab: TAB_CONFIG,
    label: "Edit values",
    value: "/edit-guard:config",
    emphasis: true,
    hint: "Open the settings modal to change values (buffered, global / project scopes).",
  });
  return rows;
}

/** Render a declared config field's current value as display text. */
function formatConfigValue(field: Field): string {
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
      // action/custom/section are filtered out upstream; anything else
      // (model) renders as JSON.
      return JSON.stringify((field as { value?: unknown }).value);
  }
}

/** Build the Audit-tab fields from session `edit-guard:event` entries. */
function buildAuditFields(ctx: ExtensionCommandContext): Field[] {
  // pi.appendEntry generates a CustomEntry (type: "custom") carrying the
  // customType + data payload. Narrow the SessionEntry union to that.
  const rawEntries = ctx.sessionManager.getEntries().filter(
    (
      e,
    ): e is {
      type: "custom";
      customType: string;
      data?: Record<string, unknown>;
    } & SessionEntry => e.type === "custom" && e.customType === "edit-guard:event",
  );

  // Batched flushes write { events: GuardEvent[] } — flatten each batch back
  // into individual events. Legacy sessions (pre-batching) hold one event
  // per entry; both shapes must render.
  const allEvents: Array<{ data: Record<string, unknown>; entryTs?: number | string }> = [];
  for (const entry of rawEntries) {
    const data = entry.data ?? {};
    if (Array.isArray(data.events)) {
      for (const event of data.events) {
        // Minimal shape check: only well-formed events render. A malformed
        // batch (manual session edit, future schema, partial-write recovery)
        // would otherwise inject N garbage rows into the audit tab.
        if (
          event &&
          typeof event === "object" &&
          typeof (event as { type?: unknown }).type === "string"
        ) {
          allEvents.push({ data: event as Record<string, unknown> });
        }
      }
    } else {
      allEvents.push({ data, entryTs: entry.timestamp });
    }
  }

  const entries = allEvents.slice(-AUDIT_LIMIT); // newest last, capped

  const fields: Field[] = [
    {
      key: "sec-audit",
      type: "section",
      label: "",
      value:
        allEvents.length > AUDIT_LIMIT
          ? `Recent audit — last ${AUDIT_LIMIT} of ${allEvents.length} events`
          : "Recent audit",
    },
  ];
  if (entries.length === 0) {
    fields.push({
      key: "audit-empty",
      type: "readonly",
      label: "No events yet",
      value: "(telemetry audit trail is empty)",
    });
    return fields.map((f) => ({ ...f, tab: TAB_AUDIT }));
  }

  for (const [entryIndex, entry] of entries.entries()) {
    const data = entry.data;
    const rawTs = data.timestamp;
    const time =
      typeof rawTs === "number" || typeof rawTs === "string"
        ? new Date(rawTs).toLocaleTimeString()
        : entry.entryTs
          ? new Date(entry.entryTs).toLocaleTimeString()
          : "?";
    fields.push({
      key: `audit-${entryIndex}`,
      type: "readonly",
      label: `${time}`,
      value: describeAuditEvent(data),
      hint: AUDIT_EVENT_HINTS[eventType(data)],
    });
  }
  return fields.map((f) => ({ ...f, tab: TAB_AUDIT }));
}

function eventType(data: Record<string, unknown>): string {
  return typeof data.type === "string" ? data.type : "event";
}

/** Human-readable one-liner for a GuardEvent audit payload. */
export function describeAuditEvent(data: Record<string, unknown>): string {
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const boolOf = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
  const path = (): string => {
    const raw = str(data.path);
    return raw ? ` ${resolveToCwd(raw, process.cwd())}` : "";
  };

  switch (eventType(data)) {
    case "edit.applied": {
      const edits = num(data.editsApplied) ?? 0;
      const anchor = boolOf(data.anchorUsed) ? " · anchor" : "";
      const ms = num(data.durationMs);
      return `edit applied · ${edits} edit${edits === 1 ? "" : "s"}${anchor}${
        ms !== undefined ? ` · ${ms} ms` : ""
      }`;
    }
    case "edit.partial":
      return `edit partial · ${num(data.appliedCount) ?? 0} applied / ${
        num(data.failedCount) ?? 0
      } failed`;
    case "edit.autopatch":
      return `autopatch · ${str(data.passName) ?? "?"} #${num(data.index) ?? 0}`;
    case "edit.envelope": {
      const edits = num(data.editsApplied) ?? 0;
      const passes = Array.isArray(data.passNames)
        ? data.passNames.filter((p): p is string => typeof p === "string")
        : [];
      return `envelope · ${edits} edit${edits === 1 ? "" : "s"}${
        passes.length > 0 ? ` (${passes.join(", ")})` : ""
      }${path()}`;
    }
    case "match.pass": {
      const autoExpand = boolOf(data.autoExpand) ? " · auto-expand" : "";
      const anchor = boolOf(data.anchorUsed) ? " · anchor" : "";
      return `match pass · ${str(data.passName) ?? "?"}${autoExpand}${anchor}`;
    }
    case "match.closest_candidate": {
      const sim = num(data.similarity);
      return `closest candidate${sim !== undefined ? ` · similarity ${sim}` : ""}`;
    }
    case "match.already_applied":
      return `already applied${path()}`;
    case "anchor.not_found":
      return `anchor not found${path()}`;
    case "anchor.ambiguous": {
      const occ = num(data.occurrences);
      return `anchor ambiguous${occ !== undefined ? ` ×${occ}` : ""}${path()}`;
    }
    case "anchor.redundant_dropped": {
      const sim = num(data.similarity);
      return `anchor redundant dropped${sim !== undefined ? ` · similarity ${sim}` : ""}${path()}`;
    }
    case "preflight.normalized":
      return `path normalized · ${str(data.toolName) ?? "?"}`;
    case "preflight.blocked":
      return `path blocked · ${str(data.toolName) ?? "?"} (${str(data.reason) ?? "?"})`;
    case "stale_read.blocked":
      return `stale-read blocked${path()}`;
    case "stale_read.self_healed":
      return `stale-read self-healed${path()}`;
    case "write_guard.denied":
      return `write denied · ${str(data.reason) ?? "?"}${path()}`;
    case "path.advisory":
      return `outside-cwd advisory · ${str(data.toolName) ?? "?"}${path()}`;
    case "overwrite_guard.blocked":
      return `overwrite blocked${path()}`;
    case "stormbreaker.enhanced": {
      const count = num(data.count);
      return `error enhanced · ${str(data.toolName) ?? "?"}${
        count !== undefined ? ` ×${count}` : ""
      }`;
    }
    case "stormbreaker.loop_broken": {
      const count = num(data.count);
      return `loop broken · ${str(data.toolName) ?? "?"}${count !== undefined ? ` ×${count}` : ""}`;
    }
    case "stormbreaker.auto_retry": {
      const count = num(data.count);
      const delay = num(data.delayMs);
      return `auto-retry · ${str(data.toolName) ?? "?"}${
        count !== undefined ? ` ×${count}` : ""
      }${delay !== undefined ? ` (delay ${delay}ms)` : ""}`;
    }
    case "repair.rule":
      return `repair rule · ${str(data.ruleId) ?? "?"} (${str(data.outcome) ?? "?"})`;
    default:
      return summarizeAuditEventFallback(data);
  }
}

function summarizeAuditEventFallback(data: Record<string, unknown>): string {
  const pass = typeof data.passName === "string" ? ` (${data.passName})` : "";
  const path = typeof data.path === "string" ? ` ${data.path}` : "";
  const count = typeof data.count === "number" ? ` ×${data.count}` : "";
  const edits = typeof data.editsApplied === "number" ? ` (${data.editsApplied} edits)` : "";
  return `${eventType(data)}${pass}${path}${count}${edits}`.trim();
}

/** Focused-row hint explaining what each audit event kind means. */
const AUDIT_EVENT_HINTS: Record<string, string> = {
  "edit.envelope": "Consolidated summary emitted once per edit tool call.",
  "edit.applied": "Edit call fully applied through the guard pipeline.",
  "edit.partial": "Edit partially applied — some of the requested edits failed.",
  "edit.autopatch": "Patch-format block corrected automatically before matching.",
  "match.pass": "oldText was resolved by this fuzzy-matching pass.",
  "match.closest_candidate": "Near-miss candidate reported for a failed oldText match.",
  "match.already_applied": "newText was already present in the file — nothing changed.",
  "anchor.not_found": "Anchor window text was not found in the file.",
  "anchor.ambiguous": "Anchor window matched more than once — edit rejected as ambiguous.",
  "anchor.redundant_dropped": "Anchor dropped because it roughly duplicated oldText.",
  "preflight.normalized": "Tool path was normalized (quotes/whitespace/cwd) before execution.",
  "preflight.blocked": "Tool call blocked — path failed preflight validation.",
  "stale_read.blocked": "Edit blocked — file changed on disk since the last read.",
  "stale_read.self_healed": "Stale-read tracking cleared after the agent's own successful write.",
  "write_guard.denied": "Write denied — outside workspace or blocked by user decision.",
  "path.advisory": "Path outside cwd — advisory appended to tool result (non-blocking).",
  "overwrite_guard.blocked": "First overwrite of an existing non-empty file blocked this session.",
  "stormbreaker.enhanced": "Cryptic tool error enhanced into actionable diagnostics.",
  "stormbreaker.loop_broken": "Repeated identical failures detected — loop broken with guidance.",
  "stormbreaker.auto_retry": "Corrective retry prompt scheduled after the loop break.",
  "repair.rule": "Argument-repair rule fired on malformed tool arguments.",
};

async function handleSettings(ctx: ExtensionCommandContext): Promise<void> {
  // Open the ConfigManager settings modal. The callback refreshes the
  // in-memory config so hooks pick up changes immediately.
  await config.openSettings(ctx, ctx.cwd, (_updated) => {
    refreshConfig(ctx.cwd);
    ctx.ui.notify("Edit Guard settings saved.", "info");
  });
}
