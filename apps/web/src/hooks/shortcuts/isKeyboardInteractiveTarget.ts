// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { isEditableTarget } from './isEditableTarget';

const INTERACTIVE_TARGET_SELECTOR =
  'input, textarea, button, a[href], select, [contenteditable="true"], [role="textbox"], [role="button"], [role="menuitem"], [data-keyboard-interactive]';

/** Shared keyboard ownership for editors, native controls, and their descendants. */
export function isKeyboardInteractiveTarget(
  target: EventTarget | null,
): boolean {
  return (
    isEditableTarget(target) ||
    (target instanceof Element &&
      target.closest(INTERACTIVE_TARGET_SELECTOR) !== null)
  );
}
