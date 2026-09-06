/**
 * Field alias table for the repair pipeline.
 *
 * Maps canonical field names to the aliases models commonly emit for them.
 * The repair pipeline uses this to rename aliased fields before validation.
 * Single table — the edit tool is the only tool surface (the patch table
 * was identical; merged because the edit tool is the only consumer).
 */

/**
 * Keyed by canonical field so consumers get compile-time enforcement:
 * a missing or typo'd canonical key is a type error, not a silently
 * dead rename surface.
 */
export interface EditFieldAliasTable {
  path: readonly string[];
  oldText: readonly string[];
  newText: readonly string[];
}

export const EDIT_FIELD_ALIASES: EditFieldAliasTable = {
  path: [
    "absolutePath",
    "file_path",
    "filePath",
    "filepath",
    "pathname",
    "target_file",
    "targetFile",
    "file",
    "absolute_path",
  ],
  oldText: [
    "old_string",
    "oldString",
    "old",
    "old_str",
    "oldStr",
    "from",
    "old_value",
    "old_text",
    "oldContent",
    "old_content",
  ],
  newText: [
    "new_string",
    "newString",
    "new",
    "new_str",
    "newStr",
    "to",
    "new_value",
    "new_text",
    "newContent",
    "new_content",
  ],
};

/**
 * Get the field aliases for a tool. Only `edit` exists now; anything else is
 * not part of the guard's surface.
 */
export function getFieldAliases(toolName: string): EditFieldAliasTable | undefined {
  if (toolName === "edit") return EDIT_FIELD_ALIASES;
  return undefined;
}
