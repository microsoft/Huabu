// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useCallback, useEffect, useRef, type RefObject } from 'react';

/** Owned selection presses must not leak compatibility clicks after commit or cancellation. */
export function useAreaSelectionClickGuard(
  wrapperRef: RefObject<HTMLDivElement | null>,
  scopeKey: string | null,
) {
  const suppressed = useRef(false);
  useEffect(() => {
    suppressed.current = false;
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const nextDown = () => {
      suppressed.current = false;
    };
    const mousedown = (event: MouseEvent) => {
      if (!suppressed.current || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const click = (event: MouseEvent) => {
      if (!suppressed.current || event.detail === 0) return;
      suppressed.current = false;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('pointerdown', nextDown, true);
    wrapper.addEventListener('mousedown', mousedown, true);
    wrapper.addEventListener('click', click, true);
    return () => {
      window.removeEventListener('pointerdown', nextDown, true);
      wrapper.removeEventListener('mousedown', mousedown, true);
      wrapper.removeEventListener('click', click, true);
    };
  }, [scopeKey, wrapperRef]);
  return useCallback(() => {
    suppressed.current = true;
  }, []);
}
