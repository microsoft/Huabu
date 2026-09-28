// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { KeyboardEvent } from 'react';

/** Keep native reader/control navigation out of the enclosing React Flow node. */
export function handleCanvasNavigationKey(event: KeyboardEvent) {
  if (
    event.key === 'ArrowLeft' ||
    event.key === 'ArrowRight' ||
    event.key === 'ArrowUp' ||
    event.key === 'ArrowDown' ||
    event.key === ' '
  ) {
    // Preserve scrolling, caret movement and native Space activation. Escape
    // and keyup continue to reach the existing focus-exit and pan-release owners.
    event.stopPropagation();
  }
}
