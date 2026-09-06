/**
 * prepareArguments for the `edit` tool override — the repair entry point.
 *
 * Thin wrapper over the generic repair pipeline (repair/pipeline.ts) wired
 * with the edit-specific schema (EDIT_SCHEMA), field-alias table, and 8
 * preprocessors (stringified-edits parsing, flat-fold, alias renames,
 * deletion/insertion inference, nested-path hoisting, …). Envelope decode
 * and truncated-JSON completion run first; adaptive policy (conservative /
 * adaptive / recover) gates which transforms may fire.
 *
 * prepareArguments has no result channel and no toolCallId, so outcome
 * notes are parked in the shared RepairLifecycle (keyed by stableSerialize
 * of the final args) and picked up later by the tool's execute() via
 * correlate()/take() to surface repair notes in the result.
 */

import { Type, type Static } from "typebox";
import { getConfig } from "../config/settings.js";
import { EDIT_FIELD_ALIASES } from "./aliases.js";
import { RepairLifecycle } from "./lifecycle.js";
import { runRepairPipeline } from "./pipeline.js";
import type { Preprocessor } from "./preprocess.js";
import { telemetry } from "../telemetry.js";

/**
 * Single source of truth for edit field aliases: the upstream-derived table
 * (mined across post-trainings of several models). Both the pre-validation
 * alias preprocessors and the validation-issue rename rule consume THIS —
 * adding an alias here widens both surfaces at once. Directly imported (not
 * via getFieldAliases) so the edit-only surface needs no undefined-narrowing.
 */
const EDIT_ALIASES = EDIT_FIELD_ALIASES;

// ---------------------------------------------------------------------------
// Schema — native edit descriptions VERBATIM (models are trained on them),
// plus the optional `anchor` field.
// ---------------------------------------------------------------------------

const replaceEditSchema = Type.Object({
  oldText: Type.String({
    description:
      "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
  }),
  newText: Type.String({
    description: "Replacement text for this targeted edit.",
  }),
  anchor: Type.Optional(
    Type.String({
      description:
        "Text copied verbatim from the file next to the target — a heading, comment, or distinctive line. Prefer adding an anchor over growing oldText: the anchor identifies WHICH copy of a repeated pattern to change, so oldText can stay short and exact. Copy it from immediately above or below the lines you are replacing.",
    }),
  ),
  replaceAll: Type.Optional(
    Type.Boolean({
      description:
        "When true, replace every occurrence of the matched text in the file. Skips the uniqueness check and ambiguity error. Use this for renames where the text appears multiple times.",
    }),
  ),
});

export const EDIT_SCHEMA = Type.Object({
  path: Type.String({
    description: "Path to the file to edit (relative or absolute)",
  }),
  edits: Type.Array(replaceEditSchema, {
    description:
      "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead. Send `edits` as an array of objects, even for a single edit.",
  }),
});

/** Static type of the edit tool's canonical argument shape. */
export type EditInput = Static<typeof EDIT_SCHEMA>;

// ---------------------------------------------------------------------------
// Shared note channel between prepareArguments and execute
// ---------------------------------------------------------------------------

export const repairLifecycle = new RepairLifecycle();

// ---------------------------------------------------------------------------
// JSON-string parsing with literal-newline fixing (the built-in edit
// argument parser only handles plain JSON.parse; this layer fixes
// literal newlines)
// ---------------------------------------------------------------------------

function fixJsonNewlines(str: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]!;
    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      result += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }
    if (inString && (ch === "\n" || ch === "\r")) {
      result += ch === "\n" ? "\\n" : "\\r";
      continue;
    }
    result += ch;
  }
  return result;
}

/** All lenient parse attempts, in order — shared by repair and diagnostics. */
function lenientParseAttempts(str: string): string[] {
  return [
    str,
    fixJsonNewlines(str),
    // Under-escaping must be repaired BEFORE punctuation cleanup: a dropped
    // "dangling fragment" may actually be string content once the missing
    // backslash restores the intended string boundary.
    repairUnderEscapedQuotes(str),
    repairJsonPunctuation(str),
    repairJsonPunctuation(repairUnderEscapedQuotes(str)),
  ];
}

function jsonParseWithNewlineFix(str: string): unknown {
  for (const attempt of lenientParseAttempts(str)) {
    try {
      return JSON.parse(attempt);
    } catch {
      // try the next strategy
    }
  }
  return undefined;
}

/**
 * Repair under-escaped quotes: a model writes file content containing `"` but
 * forgets one backslash, so the JSON string closes early and the remaining
 * content (`"],`) lands in structural position (observed in the wild:
 * file content containing a glob path and an unescaped quote (`ts"],`)
 * lands in structural position (observed in the wild). Driven by JSON.parse's
 * reported error position:
 * re-open the string by escaping the last unescaped quote before the failure
 * point, then retry. Each round must make progress; capped at 5 rounds.
 * Acceptance always gates on a full successful JSON.parse downstream.
 */
export function repairUnderEscapedQuotes(str: string): string {
  let candidate = str;
  for (let round = 0; round < 5; round++) {
    try {
      JSON.parse(candidate);
      return candidate;
    } catch (err) {
      if (!(err instanceof SyntaxError)) return candidate;
      const match = /at position (\d+)/.exec(err.message);
      if (!match) return candidate;
      const failPos = Number(match[1]);
      // Last unescaped quote strictly before the failure position.
      let quotePos = -1;
      for (let i = failPos - 1; i >= 0; i--) {
        if (candidate[i] === '"' && candidate[i - 1] !== "\\") {
          quotePos = i;
          break;
        }
        if (candidate[i - 1] === "\\") i--; // skip escaped pair
      }
      if (quotePos <= 0) return candidate;
      candidate = `${candidate.slice(0, quotePos)}\\${candidate.slice(quotePos)}`;
    }
  }
  return candidate;
}

/**
 * Repair common punctuation mistakes models make when hand-writing a
 * JSON-encoded string, without touching anything inside string literals:
 *
 * 1. trailing commas before a closing `}` / `]`
 * 2. a dangling quoted fragment directly before a closing `}` / `]`
 *    (observed as `<value>", "}` — an impossible member, always corruption)
 *
 * A scanner tracks string/escape context so replacements only ever happen at
 * structural positions. The caller still validates via JSON.parse, and the
 * result must additionally pass the schema — corrupted content cannot pass.
 */
// A quoted fragment immediately before an object/array closer is treated as
// corruption (a dangling string from a premature close) when it is at most
// this many characters and contains no member separator. Real JSON members
// are longer or contain ':', so short colon-less tails here are debris.
const MAX_DANGLING_FRAGMENT_LEN = 18;

export function repairJsonPunctuation(str: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  const skipWs = (i: number) => {
    while (i < str.length && /\s/.test(str[i]!)) i++;
    return i;
  };

  for (let i = 0; i < str.length; i++) {
    const ch = str[i]!;
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = skipWs(i + 1);
      // Case 1: trailing comma before a closing bracket.
      if (j < str.length && (str[j] === "}" || str[j] === "]")) continue;
      // Case 2: dangling quoted fragment directly before a closer,
      // e.g. `...", "}` (terminated fragment or lone stray quote) —
      // drop the comma AND the fragment's quotes.
      if (str[j] === '"') {
        let k = j + 1;
        let closedAt = -1;
        let hitCloser = false;
        while (k < str.length) {
          const c = str[k]!;
          if (c === "\\") {
            k += 2;
            continue;
          }
          if (c === '"') {
            closedAt = k;
            break;
          }
          if (c === "}" || c === "]") {
            hitCloser = true;
            break;
          }
          k++;
        }
        if (hitCloser) {
          // Lone stray quote abutting the closer (`,"}`, `," ]`) — drop both.
          // Whitespace between quote and closer is skipped by the scan above.
          i = j;
          continue;
        }
        if (!hitCloser && closedAt > j) {
          const after = skipWs(closedAt + 1);
          const fragment = str.slice(j, closedAt + 1);
          if (
            after < str.length &&
            (str[after] === "}" || str[after] === "]") &&
            fragment.length <= MAX_DANGLING_FRAGMENT_LEN &&
            !fragment.includes(":")
          ) {
            // Short quoted fragment with no member separator directly
            // before a closer can never be valid JSON — corruption.
            i = closedAt;
            continue;
          }
        }
      }
    }
    out += ch;
  }
  return out;
}

const EDITS_SHAPE_HINT =
  'edits must be a JSON array of objects, e.g. "edits": [{"oldText": "a", "newText": "b"}] — never a string containing JSON.';

function isEditObject(value: unknown): value is { oldText: string; newText: string } {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).oldText === "string" &&
    typeof (value as Record<string, unknown>).newText === "string"
  );
}

/** Normalize whatever the model sent for `edits` into an array of edit objects. */
function normalizeEdits(edits: unknown): unknown {
  if (typeof edits === "string") {
    const trimmed = edits.trim();
    if (!trimmed) return edits;
    const parsed = jsonParseWithNewlineFix(trimmed);
    if (Array.isArray(parsed)) return normalizeEdits(parsed);
    if (isEditObject(parsed)) return [parsed];
    throw new Error(
      `edit: could not parse the "edits" string as a JSON array. ${EDITS_SHAPE_HINT}`,
    );
  }
  if (isEditObject(edits)) return [edits];
  if (!Array.isArray(edits)) return edits;
  return edits.map((entry) => {
    if (typeof entry !== "string") return entry;
    const parsed = jsonParseWithNewlineFix(entry);
    if (isEditObject(parsed)) return parsed;
    throw new Error(`edit: could not parse edits entry as an edit object. ${EDITS_SHAPE_HINT}`);
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Remove empty-string entries from the `edits` array in an edit argument
 * object. No-op when `edits` is missing or already clean.
 */
function sanitizeEdits(input: unknown): unknown {
  if (!isPlainObject(input)) return input;
  const edits = input.edits;
  if (!Array.isArray(edits)) return input;
  const filtered = edits.filter((edit): edit is Record<string, unknown> => edit !== "");
  if (filtered.length === edits.length) return input;
  return { ...input, edits: filtered };
}

// ---------------------------------------------------------------------------
// Preprocessors (run before strict validation — see runRepairPipeline)
// ---------------------------------------------------------------------------

/** Parse a JSON-stringified `edits` array, tolerating literal newlines. */
const parseStringifiedEdits: Preprocessor = {
  kind: "structural",
  selector: "/edits",
  ruleId: "parse-stringified-edits",
  apply: (value) => {
    if (typeof value !== "string") return undefined;
    const parsed = jsonParseWithNewlineFix(value);
    if (!Array.isArray(parsed)) return undefined;
    return {
      value: parsed,
      note: 'Parsed your JSON-stringified `edits` array for tool "edit". Send the array literal directly next time, not a string.',
    };
  },
};

/** Drop empty-string entries from `edits[]` before schema validation. */
const filterEmptyEdits: Preprocessor = {
  kind: "structural",
  selector: "/edits",
  ruleId: "filter-empty-edits",
  apply: (value) => {
    if (!Array.isArray(value)) return undefined;
    const filtered = value.filter((edit) => edit !== "");
    if (filtered.length === value.length) return undefined;
    return {
      value: filtered,
      note: 'Removed empty-string entries from `edits` for tool "edit".',
    };
  },
};

/**
 * Flat-fold: the model sent oldText/newText/anchor at the top level instead
 * of inside edits[]. Accepts camelCase (oldText/newText) and snake_case
 * (old_str/new_str) variants. Mirrors native prepareEditArguments' flat fold
 * (flat keys are APPENDED to an existing edits array, matching upstream),
 * extended with the snake_case keys and anchor.
 */
const flatFold: Preprocessor = {
  kind: "structural",
  selector: "/",
  ruleId: "flat-fold",
  apply: (value) => {
    if (!isPlainObject(value)) return undefined;
    const args = value;

    const oldText =
      typeof args.oldText === "string"
        ? args.oldText
        : typeof args.old_str === "string"
          ? args.old_str
          : undefined;
    const newText =
      typeof args.newText === "string"
        ? args.newText
        : typeof args.new_str === "string"
          ? args.new_str
          : undefined;
    if (typeof oldText !== "string" || typeof newText !== "string") return undefined;

    const edit: Record<string, unknown> = { oldText, newText };
    const anchor = typeof args.anchor === "string" ? args.anchor : undefined;
    if (anchor !== undefined) edit.anchor = anchor;
    const replaceAll = typeof args.replaceAll === "boolean" ? args.replaceAll : undefined;
    if (replaceAll !== undefined) edit.replaceAll = replaceAll;

    const {
      oldText: _o,
      newText: _n,
      old_str: _os,
      new_str: _ns,
      anchor: _a,
      replaceAll: _ra,
      ...rest
    } = args;
    const edits = Array.isArray(args.edits) ? [...args.edits] : [];
    edits.push(edit);
    return {
      value: { ...rest, edits },
      note: 'Folded your flat oldText/newText into edits for tool "edit". Send `edits` as an array of { oldText, newText } objects next time.',
    };
  },
};

/**
 * Field aliases at any depth (path at root, oldText/newText inside edit
 * elements) — alias lists come from the shared EDIT_ALIASES table, so a
 * model sending `absolutePath`, `old_text`, `newContent`, … gets renamed
 * with a teaching note instead of a validation failure.
 */
const aliasPreprocessors: Preprocessor[] = [
  {
    kind: "alias",
    selector: "/path",
    aliases: EDIT_ALIASES.path,
    accepts: "string",
  },
  {
    kind: "alias",
    selector: "/edits/*/oldText",
    aliases: EDIT_ALIASES.oldText,
    accepts: "string",
  },
  {
    kind: "alias",
    selector: "/edits/*/newText",
    aliases: EDIT_ALIASES.newText,
    accepts: "string",
  },
  {
    kind: "alias",
    selector: "/edits/*/path",
    aliases: EDIT_ALIASES.path,
    accepts: "string",
  },
];

/**
 * Hoist a misplaced per-edit `path` to the root.
 *
 * deepseek-v4-pro (observed 15× in one live session) sends
 * `{ edits: [{ oldText, newText, path }] }` with NO root `path`, failing
 * validation with `(root): must have required properties path`. When every
 * nested path agrees, hoisting is exactly what the model does on retry.
 * Disagreeing paths are left invalid — one call cannot span multiple files;
 * prepareEditArguments enriches that failure with a split-it message instead.
 */
const hoistNestedPath: Preprocessor = {
  kind: "structural",
  selector: "/",
  ruleId: "hoist-nested-path",
  apply: (value) => {
    if (!isPlainObject(value)) return undefined;
    const args = value;
    const existing = args.path;
    if (typeof existing === "string" && existing.length > 0) return undefined;

    const edits = args.edits;
    if (!Array.isArray(edits)) return undefined;

    const nestedPaths = new Set<string>();
    for (const edit of edits) {
      if (!isPlainObject(edit)) continue;
      const p = edit.path;
      if (typeof p !== "string" || p.length === 0) continue;
      nestedPaths.add(p);
      // Also accept a path alias that survived above only via /edits/*/path alias.
    }
    if (nestedPaths.size !== 1) return undefined;
    const path = nestedPaths.values().next().value!;

    const cleanedEdits = edits.map((edit) => {
      if (!isPlainObject(edit) || !("path" in edit)) return edit;
      const { path: _p, ...rest } = edit;
      return rest;
    });

    return {
      value: { ...args, path, edits: cleanedEdits },
      note: 'Moved the file `path` from inside `edits[]` to the top level for tool "edit". The path belongs at the root of the arguments, next time send it there.',
    };
  },
};

/**
 * Detect the two known unrepairable argument shapes and produce targeted,
 * actionable guidance appended to the schema retry message. Returns null when
 * nothing specific applies.
 */
export function describeUnrepairableEditInput(input: unknown): string | null {
  if (!isPlainObject(input)) return null;

  const edits = input.edits;
  if (typeof edits === "string") {
    let lastError: SyntaxError | undefined;
    for (const attempt of lenientParseAttempts(edits)) {
      try {
        const value = JSON.parse(attempt);
        if (Array.isArray(value)) return null; // parseable — not this failure
        return "The `edits` value is a double-encoded JSON STRING but it is not an array. Send `edits` as a real JSON array of { oldText, newText } objects.";
      } catch (err) {
        lastError = err instanceof SyntaxError ? err : undefined;
      }
    }
    return (
      "The `edits` value is a double-encoded JSON STRING and it failed to parse " +
      `(${lastError?.message ?? "invalid JSON"}). Send \`edits\` as a real JSON array of ` +
      "{ oldText, newText } objects."
    );
  }

  if (Array.isArray(edits) && !(typeof input.path === "string" && input.path.length > 0)) {
    const distinct = new Set<string>();
    for (const edit of edits) {
      if (isPlainObject(edit) && typeof edit.path === "string" && edit.path.length > 0) {
        distinct.add(edit.path);
      }
    }
    if (distinct.size > 1) {
      return (
        `Found ${distinct.size} different \`path\` values inside \`edits[]\` (${[...distinct]
          .map((p) => `"${p}"`)
          .join(", ")}). One edit call can only target ONE file: put a single \`path\` at the ` +
        "top level and split edits for other files into separate calls."
      );
    }
  }

  if (Array.isArray(edits)) {
    for (const [i, edit] of edits.entries()) {
      if (!isPlainObject(edit)) continue;
      const hasOldText =
        "oldText" in edit && typeof edit.oldText === "string" && edit.oldText.length > 0;
      const hasNewText = "newText" in edit && typeof edit.newText === "string";
      if (!hasOldText && hasNewText) {
        return (
          `\`edits[${i}]\` has \`newText\` but no \`oldText\`, so there is nothing to search for. ` +
          "To INSERT lines, set `oldText` to the existing line(s) the insertion attaches to and " +
          "include them verbatim at the head of your `newText`. To REPLACE, send the exact " +
          "current text as `oldText`."
        );
      }
    }
  }

  return null;
}

/**
 * Drop empty-object placeholder entries (`{}`) from `edits[]`.
 *
 * Observed in the wild (native era, 90+ calls across 2026-04..06 sessions):
 * models emit `{}` placeholders alongside real edits — e.g.
 * `[{ }, { oldText, newText }]` — and native rejects the whole call with
 * noisy per-property errors on index 0 while the REAL edit at index 1 was
 * fine. Dropping empties lets the surviving edits through; if every entry
 * was empty, the array becomes empty and validation fails with the honest
 * min-items error instead of phantom property noise.
 */
const dropEmptyEditObjects: Preprocessor = {
  kind: "structural",
  selector: "/edits",
  ruleId: "drop-empty-edit-objects",
  apply: (value) => {
    if (!Array.isArray(value)) return undefined;
    const filtered = value.filter(
      (edit) => !(isPlainObject(edit) && Object.keys(edit).length === 0),
    );
    if (filtered.length === value.length) return undefined;
    return {
      value: filtered,
      note: 'Removed empty-object placeholder entries from `edits` for tool "edit".',
    };
  },
};

/**
 * Interpret an edit that has ONLY oldText (+ optional anchor/replaceAll) as a
 * DELETION by defaulting newText to "".
 *
 * Observed in the wild (~50 calls in 2026-05/06 sessions):
 * `{ oldText: "..." }` with no newText at all. An edit needs a change; with
 * search text present and no replacement given, removal is the only sensible
 * reading (matches how string-replacement APIs document deletions). Runs
 * AFTER field aliases so aliased old_text-only shapes are covered too.
 */
const inferDeletionMissingNewText: Preprocessor = {
  kind: "structural",
  selector: "/edits/*",
  ruleId: "infer-deletion-missing-newtext",
  apply: (value) => {
    if (!isPlainObject(value)) return undefined;
    if ("newText" in value || "new_string" in value || "newString" in value || "new_str" in value)
      return undefined;
    if (typeof value.oldText !== "string" || value.oldText.length === 0) return undefined;
    return {
      value: { ...value, newText: "" },
      note: 'Your edit had `oldText` but no `newText`; interpreted it as a DELETION (newText: ""). Send explicit text if you meant a replacement.',
    };
  },
};

/**
 * Interpret an edit that has ONLY newText (+ anchor) as an INSERTION by
 * deriving oldText from the anchor.
 *
 * Observed in the wild (10 stepfun calls, 2026-08 sessions):
 * `{ anchor: 'echo "End"', newText: 'echo "End"\n<more lines>' }` — no
 * oldText at all. The model expresses "add lines after X" by embedding X
 * verbatim at the head of its replacement. When the anchor text appears
 * inside newText, rewriting the entry as { oldText: anchor, newText } is
 * exactly that edit; downstream anchor/uniqueness guards stay in force.
 * Without an anchor (or without containment) the insertion point is
 * unknowable — describeUnrepairableEditInput emits a targeted hint instead
 * of generic schema noise.
 */
const inferInsertionMissingOldText: Preprocessor = {
  kind: "structural",
  selector: "/edits/*",
  ruleId: "infer-insertion-missing-oldtext",
  apply: (value) => {
    if (!isPlainObject(value)) return undefined;
    if ("oldText" in value || "old_string" in value || "oldString" in value || "old_str" in value) {
      return undefined;
    }
    if (typeof value.newText !== "string" || value.newText.length === 0) return undefined;
    const anchor =
      typeof value.anchor === "string"
        ? value.anchor
        : typeof (value as Record<string, unknown>).anchor_text === "string"
          ? ((value as Record<string, unknown>).anchor_text as string)
          : undefined;
    if (typeof anchor !== "string" || anchor.trim().length === 0) return undefined;
    if (!value.newText.includes(anchor)) return undefined;
    return {
      value: { ...value, oldText: anchor },
      note: "Your edit had `newText` and an `anchor` but no `oldText`; since the anchor text appears verbatim inside your replacement, interpreted it as replacing the anchor text with `newText` (an insertion after the anchor). Send explicit `oldText` next time.",
    };
  },
};

const PREPROCESSORS: readonly Preprocessor[] = [
  parseStringifiedEdits,
  filterEmptyEdits,
  {
    kind: "structural",
    selector: "/edits",
    ruleId: "normalize-edits",
    apply: (value) => {
      if (value === undefined || value === null) return undefined;
      if (Array.isArray(value) && value.every((entry) => typeof entry !== "string"))
        return undefined;
      try {
        return {
          value: normalizeEdits(value),
          note: 'Normalized `edits` into an array of edit objects for tool "edit". Send `edits` as an array next time.',
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `${message} Send \`edits\` as a JSON array of { oldText, newText } objects.`,
        );
      }
    },
  },
  filterEmptyEdits,
  dropEmptyEditObjects,
  ...aliasPreprocessors,
  inferDeletionMissingNewText,
  inferInsertionMissingOldText,
  hoistNestedPath,
  flatFold,
];

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Native-subset compatibility, ALWAYS on (native edit does this in
 * prepareEditArguments regardless of any config): parse a JSON-stringified
 * `edits` array and fold flat oldText/newText into edits[]. Without these,
 * disabling repair would regress native behavior — flat/stringified args
 * would fail schema validation outright.
 */
function applyNativeCompatibility(input: unknown): unknown {
  if (!isPlainObject(input)) return input;
  let value = input;

  const applyStructural = (
    pp: Preprocessor,
    v: unknown,
  ): { value: unknown; note: string } | undefined =>
    pp.kind === "structural" ? pp.apply(v) : undefined;

  const stringified = applyStructural(parseStringifiedEdits, value.edits);
  if (stringified) value = { ...value, edits: stringified.value };

  const sanitized = sanitizeEdits(value);
  if (sanitized !== value) value = sanitized as Record<string, unknown>;

  const folded = applyStructural(flatFold, value);
  if (folded) value = folded.value as Record<string, unknown>;

  return value;
}

/**
 * prepareArguments for the edit override. Runs the full repair pipeline and
 * On the unrepairable path, throws the retry message — pi catches it in
 * prepareToolCall and returns a clean tool-error result. When repair is
 * disabled, still applies the native subset (flat fold + JSON-string parse)
 * so argument compatibility never regresses.
 */
export function prepareEditArguments(input: unknown): unknown {
  const cfg = getConfig();
  if (!cfg.repairEnabled) return applyNativeCompatibility(input);

  const result = runRepairPipeline({
    input,
    config: {
      toolName: "edit",
      schema: EDIT_SCHEMA,
      policy: cfg.repairPolicy,
      preprocessors: PREPROCESSORS,
      legacyConfig: {
        // Same table as the preprocessors — one source of truth.
        fieldAliases: EDIT_ALIASES,
      },
    },
  });

  if (result.outcome === "unrepairable") {
    telemetry.record({
      type: "repair.rule",
      timestamp: Date.now(),
      ruleId: "unrepairable",
      outcome: "unrepairable",
      fingerprint: result.fingerprint,
    });
    const base = result.retryMessage ?? "Unable to repair edit arguments.";
    const hint = describeUnrepairableEditInput(input);
    throw new Error(hint ? `${base}\n  • ${hint}` : base);
  }

  if (result.outcome === "repaired") {
    repairLifecycle.enqueue("edit", result.args, {
      rules: result.changes.map((change) => change.ruleId),
      notes: result.changes.map((change) => change.note),
      stages: result.changes.map((change) => change.stage),
      profile: result.policy,
      outcome: "repaired",
      fingerprint: result.fingerprint,
    });
    for (const change of result.changes) {
      telemetry.record({
        type: "repair.rule",
        timestamp: Date.now(),
        ruleId: change.ruleId,
        outcome: "repaired",
      });
    }
  }

  return result.args;
}
