/**
 * Barrel exports for the shortcut hooks + shared helpers.
 *
 * Two hooks share a folder because they share the same domain (keyboard
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

export { usePageShortcuts } from './usePageShortcuts';
export type { UsePageShortcutsResult } from './usePageShortcuts';

export { isEditableTarget } from './isEditableTarget';
