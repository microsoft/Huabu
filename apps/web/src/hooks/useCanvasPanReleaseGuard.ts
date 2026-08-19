// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useRef, type MutableRefObject } from 'react';

interface MouseReleaseInit {
  button: number;
  clientX: number;
  clientY: number;
  screenX: number;
  screenY: number;
}

export function attachCanvasPanReleaseGuard(
  wrapper: HTMLElement,
  isLeftDragPanEnabled: () => boolean,
): () => void {
  let activePointerId: number | null = null;
  let releaseInit: MouseReleaseInit | null = null;

  const clear = () => {
    activePointerId = null;
    releaseInit = null;
  };

  const dispatchFallbackMouseUp = () => {
    if (activePointerId === null || !releaseInit) return;
    const init = releaseInit;
    activePointerId = null;
    releaseInit = null;
    window.dispatchEvent(
      new MouseEvent('mouseup', {
        ...init,
        bubbles: true,
        cancelable: true,
        view: window,
        buttons: 0,
      }),
    );
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse') return;
    if (event.button !== 1 && !(event.button === 0 && isLeftDragPanEnabled())) {
      return;
    }
    activePointerId = event.pointerId;
    releaseInit = {
      button: event.button,
      clientX: event.clientX,
      clientY: event.clientY,
      screenX: event.screenX,
      screenY: event.screenY,
    };
  };

  const onPointerUp = (event: PointerEvent) => {
    if (activePointerId !== event.pointerId) return;
    releaseInit = {
      button: event.button,
      clientX: event.clientX,
      clientY: event.clientY,
      screenX: event.screenX,
      screenY: event.screenY,
    };
    dispatchFallbackMouseUp();
  };

  const onPointerMove = (event: PointerEvent) => {
    if (
      activePointerId === event.pointerId &&
      event.pointerType === 'mouse' &&
      event.buttons === 0
    ) {
      dispatchFallbackMouseUp();
    }
  };

  const onPointerCancel = (event: PointerEvent) => {
    if (activePointerId !== event.pointerId) return;
    dispatchFallbackMouseUp();
  };

  const onBlur = () => {
    if (activePointerId !== null) dispatchFallbackMouseUp();
  };

  wrapper.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointermove', onPointerMove, true);
  window.addEventListener('pointerup', onPointerUp, true);
  window.addEventListener('pointercancel', onPointerCancel, true);
  window.addEventListener('mouseup', clear);
  window.addEventListener('blur', onBlur);
  return () => {
    wrapper.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('pointerup', onPointerUp, true);
    window.removeEventListener('pointercancel', onPointerCancel, true);
    window.removeEventListener('mouseup', clear);
    window.removeEventListener('blur', onBlur);
    clear();
  };
}

export function useCanvasPanReleaseGuard(
  wrapperRef: MutableRefObject<HTMLDivElement | null>,
  leftDragPanEnabled: boolean,
): void {
  const leftDragPanEnabledRef = useRef(leftDragPanEnabled);
  leftDragPanEnabledRef.current = leftDragPanEnabled;

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    return attachCanvasPanReleaseGuard(
      wrapper,
      () => leftDragPanEnabledRef.current,
    );
  }, [wrapperRef]);
}
