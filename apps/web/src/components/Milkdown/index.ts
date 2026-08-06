// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Public barrel for the Milkdown wrapper.
 *
 * Only the symbols exported here may be imported outside
 * `apps/web/src/components/Milkdown/`. The boundary is enforced by the
 * grep check in CI (no `@milkdown/*` imports outside this directory).
 */

export { MilkdownEditor } from './MilkdownEditor';
export type { MilkdownEditorProps } from './MilkdownEditor';

export type { MilkdownInstance } from './createMilkdown';
export type { MilkdownBlockSnapshot } from './createMilkdown';

export { MilkdownPreview } from './MilkdownPreview';
export type { MilkdownPreviewProps } from './MilkdownPreview';

export {
  ensureNonEmpty,
  markdownEquals,
  normalizeMarkdown,
  normalizeMathDelimiters,
} from './markdownUtils';

export type {
  MilkdownBackgroundColor,
  MilkdownBlockDragEvent,
  MilkdownBlockType,
  MilkdownDecorationSpec,
  MilkdownFormattingState,
  MilkdownInlineMark,
  MilkdownTextColor,
  MilkdownToolbarMode,
} from './types';
