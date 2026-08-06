// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect } from 'react';

/**
 * Marker attribute placed on the canvas wrapper. Anything inside this
 * element keeps its native pinch / zoom behaviour (the canvas owns its
 * own zoom logic via React Flow + `useCanvasGestures`). Everything
 * outside has browser zoom suppressed.
 */
const CANVAS_ROOT_SELECTOR = '[data-canvas-root]';

/**
 * Disable browser pinch-to-zoom (and Cmd/Ctrl +/-/0 shortcuts) on the
 * whole page, *except* inside the canvas wrapper.
 *
 * Trackpad pinch on Chromium/WebKit dispatches a `wheel` event with
 * `ctrlKey = true`; Safari additionally dispatches non-standard
 * `gesturestart/change/end` events. We listen on `window` in the
 * capture phase with `passive: false` so we can `preventDefault()`
 * before the browser handles the gesture.
 *
 * Events whose target is inside `[data-canvas-root]` are ignored, so
 * the canvas's own zoom handlers continue to receive them untouched.
 *
 * Call once near the app root.
 */
export function useDisableBrowserZoom(): void {
  useEffect(() => {
    const isInsideCanvas = (target: EventTarget | null): boolean => {
      if (!(target instanceof Element)) return false;
      return target.closest(CANVAS_ROOT_SELECTOR) !== null;
    };

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      if (isInsideCanvas(e.target)) return;
      e.preventDefault();
    };

    // Safari-only "gesture" events fire for trackpad pinch and don't
    // always come with a matching wheel event, so we have to block
    // them explicitly.
    const onGesture = (e: Event) => {
      if (isInsideCanvas(e.target)) return;
      e.preventDefault();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      // Block Cmd/Ctrl + "+" / "-" / "=" / "0" which the browser maps
      // to zoom in / zoom out / reset.
      if (e.key === '+' || e.key === '-' || e.key === '=' || e.key === '0') {
        if (isInsideCanvas(e.target)) return;
        e.preventDefault();
      }
    };

    const wheelOpts: AddEventListenerOptions = {
      capture: true,
      passive: false,
    };
    window.addEventListener('wheel', onWheel, wheelOpts);
    window.addEventListener('gesturestart', onGesture, wheelOpts);
    window.addEventListener('gesturechange', onGesture, wheelOpts);
    window.addEventListener('gestureend', onGesture, wheelOpts);
    window.addEventListener('keydown', onKeyDown, { capture: true });

    return () => {
      window.removeEventListener('wheel', onWheel, { capture: true });
      window.removeEventListener('gesturestart', onGesture, { capture: true });
      window.removeEventListener('gesturechange', onGesture, { capture: true });
      window.removeEventListener('gestureend', onGesture, { capture: true });
      window.removeEventListener('keydown', onKeyDown, { capture: true });
    };
  }, []);
}
