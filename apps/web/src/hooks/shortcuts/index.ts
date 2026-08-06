// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Barrel exports for the shortcut hooks + shared helpers.
 *
 * These hooks share a folder because they share the same domain (keyboard
 * shortcuts) and the same `isEditableTarget` helper. Importing via the
 * barrel keeps consumers untied to the file layout — if we later split
 * one hook into multiple files, the public surface stays stable.
 */
export { useCanvasShortcuts } from './useCanvasShortcuts';
export type {
  CanvasShortcutRefs,
  CanvasTool,
  UseCanvasShortcutsOptions,
} from './useCanvasShortcuts';

export { useShortcutsHelpHotkey } from './useShortcutsHelpHotkey';

export { useAppShortcuts } from './useAppShortcuts';

export { isEditableTarget } from './isEditableTarget';
