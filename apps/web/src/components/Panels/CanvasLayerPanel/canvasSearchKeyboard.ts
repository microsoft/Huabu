// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { isEditableTarget } from '../../../hooks/shortcuts/isEditableTarget';

const INTERACTIVE_TARGET_SELECTOR =
  'input, textarea, button, a[href], select, [contenteditable="true"], [role="textbox"], [role="button"], [role="menuitem"]';

export function shouldCanvasSearchOwnKeyboard(
  target: EventTarget | null,
): boolean {
  if (!(target instanceof Element)) return false;
  if (
    target.closest('[data-canvas-search-input], [data-canvas-search-results]')
  ) {
    return true;
  }
  if (isEditableTarget(target) || target.closest(INTERACTIVE_TARGET_SELECTOR)) {
    return false;
  }
  return target.closest('[data-canvas-root]') !== null;
}
