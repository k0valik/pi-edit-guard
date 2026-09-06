// Adapter: converts our PatchEdit[] to the ParsedBlock[] shape the
// pi-semantic-edit engine expects. The engine operates on ParsedBlock[]
// (path + oldText + newText), so we extract the path separately and map
// each PatchEdit into a ParsedBlock.

import type { PatchEdit } from "../model.js";
import type { ParsedBlock } from "../model.js";

/**
 * Convert edit-tool arguments into ParsedBlock[] for the domain engine.
 * The `path` is stripped from each edit (it's passed separately to
 * resolveBlocks/applyEdits); only oldText/newText flow into ParsedBlock.
 */
export function patchEditsToBlocks(edits: PatchEdit[]): ParsedBlock[] {
  return edits.map((edit) => ({
    path: "", // resolved by the caller
    oldText: edit.oldText,
    newText: edit.newText,
    anchor: edit.anchor,
    replaceAll: edit.replaceAll,
  }));
}
