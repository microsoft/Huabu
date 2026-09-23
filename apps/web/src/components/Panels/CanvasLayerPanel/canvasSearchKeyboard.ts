// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { isKeyboardInteractiveTarget } from '../../../hooks/shortcuts/isKeyboardInteractiveTarget';

export function shouldCanvasSearchOwnKeyboard(
  target: EventTarget | null,
): boolean {
  if (!(target instanceof Element)) return false;
  if (
    target.closest('[data-canvas-search-input], [data-canvas-search-results]')
  ) {
    return true;
  }
  if (isKeyboardInteractiveTarget(target)) {
    return false;
  }
  return target.closest('[data-canvas-root]') !== null;
}
