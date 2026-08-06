// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Returns true when the target is an editable element
 * (input / textarea / contentEditable / role="textbox").
 *
 * Shared between the page-level and canvas-level shortcut hooks so we
 * skip handling keystrokes when the user is actually typing.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  const tag = el?.tagName?.toLowerCase();
  if (tag === 'input' || tag === 'textarea') return true;
  return (
    el?.isContentEditable || el?.getAttribute?.('role') === 'textbox' || false
  );
}
