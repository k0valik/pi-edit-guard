/**
 * Backward-compatible re-export.
 *
 * The canonical entry point is `src/extension.ts`. This file remains so
 * existing `pi.extensions` entries like `"./extension.ts"` continue to work.
 */

export { default } from "./src/extension.js";
