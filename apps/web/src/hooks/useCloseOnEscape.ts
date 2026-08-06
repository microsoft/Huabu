// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Dismiss an open overlay (popover, picker, menu) with the Escape key.
 *
 * Overlays that can only be dismissed by clicking a backdrop are
 * unreachable for keyboard users, so every backdrop-dismissible surface
 * pairs its outside-click handler with this hook. Propagation is stopped
 * so Escape dismisses the overlay without also reaching the canvas,
 * where it would clear the selection.
 */

import { useEffect, useRef } from 'react';

export function useCloseOnEscape(isOpen: boolean, onClose: () => void) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onCloseRef.current();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen]);
}
