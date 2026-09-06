/**
 * @k0valik/pi-base/settings — public entry point for the settings
 * modal feature (vendored from wierdbytes/pi-common/settings).
 *
 * High-level: `openSettingsModal(ctx, opts)` opens a centered popup,
 * persists changes via `opts.onChange`, and resolves on close.
 *
 * Mid-level: `createSettingsModal(ctx, opts)` returns a `ctx.ui.custom`
 * factory for callers that manage their own overlay lifecycle.
 *
 * Low-level: `createSettingsModalBody`, `frame`, `inline-edit` helpers,
 * built-in `RENDERERS` map, and the full `Field` discriminated union
 * are all exported for callers building bespoke layouts on top of the
 * same primitives.
 */

export { createSettingsModal, openSettingsModal } from "./modal";

export { createSettingsModalBody } from "./body";

export {
  divider,
  formatHintLine,
  frame,
  frameContentWidth,
  pad,
  responsiveInnerRows,
  wrapLine,
  type FrameOptions,
  type KeyHint,
} from "./frame";

export {
  clampInlineCursor,
  deleteWordBackward,
  handleInlineEditInput,
  insertInlineText,
  renderInlineEditValue,
  type InlineEditState,
} from "./inline-edit";

export { RENDERERS } from "./fields/index";

export { validateFieldValue } from "./validate-field";

export type {
  ActionField,
  BooleanField,
  CustomField,
  CustomFieldRenderArgs,
  CustomFieldSubmenuArgs,
  EnumField,
  Field,
  FieldBase,
  FieldKeyHint,
  FieldKeyResult,
  FieldRenderContext,
  FieldRenderer,
  FieldRow,
  ModelField,
  ModelOption,
  ModelValue,
  NumberField,
  PathField,
  ReadonlyField,
  SecretField,
  SectionField,
  SettingsModalFactory,
  SettingsModalOptions,
  SettingsTheme,
  StringField,
  SubmenuFactory,
  Tab,
  TextField,
  ValueOfField,
  VisibilityContext,
} from "./types";
