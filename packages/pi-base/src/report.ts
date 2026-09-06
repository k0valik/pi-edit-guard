// Shared report rendering helpers for pi extensions.
//
// Provides themed report title, section headers, dimmed lines,
// key/value rows, overflow hints, and wrapped text blocks.
// All functions truncate to the given width.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** Minimal theme surface required by the shared report helpers. */
export type ReportTheme = Pick<Theme, "fg">;

/** Color keys accepted by the report helpers. */
export type ReportColor = Parameters<Theme["fg"]>[0];

/** Options for rendering a themed key/value report row. */
export interface KeyValueLineOptions {
  label: string;
  value: string;
  theme: ReportTheme;
  width: number;
  indent?: number;
  labelColor?: ReportColor;
  valueColor?: ReportColor;
  separator?: string;
}

/** Options for rendering a preview-overflow hint. */
export interface OverflowHintOptions {
  hint?: string | null;
  indent?: number;
}

/** Ensure a report width never drops below the minimum readable width. */
export function clampReportWidth(width: number, minWidth = 24): number {
  return Math.max(minWidth, width);
}

/** Render a top-level report title line with theme color and truncation. */
export function formatReportTitle(
  title: string,
  theme: ReportTheme,
  width: number,
  color: ReportColor = "accent",
): string {
  return truncateToWidth(theme.fg(color, title), width);
}

/** Render a section header with optional dimmed metadata. */
export function formatSectionHeader(
  title: string,
  meta: string | null,
  theme: ReportTheme,
  width: number,
): string {
  const left = theme.fg("text", title);
  const content = meta ? `${left}${theme.fg("dim", `  ${meta}`)}` : left;
  return truncateToWidth(content, width);
}

/** Render a single dimmed report line with optional left indentation. */
export function formatDimLine(text: string, theme: ReportTheme, width: number, indent = 0): string {
  const safeIndent = Math.max(0, indent);
  return truncateToWidth(`${" ".repeat(safeIndent)}${theme.fg("dim", text)}`, width);
}

/** Render a dimmed preview-overflow hint such as `… and 3 more — run /foo full`. */
export function formatOverflowHint(
  hiddenCount: number,
  theme: ReportTheme,
  width: number,
  options: OverflowHintOptions = {},
): string {
  const { hint = null, indent = 2 } = options;
  const suffix = hint ? ` — ${hint}` : "";
  return formatDimLine(`… and ${hiddenCount} more${suffix}`, theme, width, indent);
}

/** Render a single themed `label: value` row with truncation. */
export function formatKeyValueLine(options: KeyValueLineOptions): string {
  const {
    label,
    value,
    theme,
    width,
    indent = 2,
    labelColor = "text",
    valueColor = "dim",
    separator = ": ",
  } = options;
  const safeIndent = Math.max(0, indent);

  return truncateToWidth(
    `${" ".repeat(safeIndent)}${theme.fg(labelColor, label)}${separator}${theme.fg(valueColor, value)}`,
    width,
  );
}

/** Wrap a report text block to the available width with optional indent prefix. */
export function wrapReportText(
  text: string,
  width: number,
  options: { indent?: string } = {},
): string[] {
  const indent = options.indent ?? "";
  const wrapped = wrapTextWithAnsi(text, Math.max(1, width - indent.length));
  return indent ? wrapped.map((line) => `${indent}${line}`) : wrapped;
}
