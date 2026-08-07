// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useRef } from 'react';

import { FLOATING_CHROME_SELECTOR } from '@/components/Common/floatingChrome';

/**
 * Reports which surface the user is working in, so floating chrome can
 * step aside while they are busy somewhere else.
 *
 * Attention follows the last *deliberate* interaction — a pointer press
 * or a focus change — rather than the pointer position. Hover would be
 * the obvious signal and is the wrong one: merely sweeping the cursor
 * across another panel on the way somewhere else would blink the chrome
 * out and back, and defending against that needs grace timers that then
 * make the chrome feel laggy. A press/focus signal is discrete and
 * sticky: chrome disappears exactly once, when the user commits to
 * another surface, and comes back the moment they return.
 *
 * Listeners are capture-phase on `document` so a handler calling
 * `stopPropagation` (common inside popovers and editors) cannot blind
 * us.
 *
 * @param isOwnSurface Whether an interaction on this element still
 *   counts as "working in my surface".
 * @param onAttentionChange Receives the verdict for every deliberate
 *   interaction (including repeats).
 *
 * Both callbacks are read through refs, so they do not need to be
 * referentially stable and changing them never re-subscribes.
 */
export function useTrackAttention(
  isOwnSurface: (target: Element) => boolean,
  onAttentionChange: (engaged: boolean) => void,
): void {
  const isOwnSurfaceRef = useRef(isOwnSurface);
  isOwnSurfaceRef.current = isOwnSurface;
  const onAttentionChangeRef = useRef(onAttentionChange);
  onAttentionChangeRef.current = onAttentionChange;

  useEffect(() => {
    const handleInteraction = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(FLOATING_CHROME_SELECTOR)) return;
      onAttentionChangeRef.current(isOwnSurfaceRef.current(target));
    };
    document.addEventListener('pointerdown', handleInteraction, true);
    document.addEventListener('focusin', handleInteraction, true);
    return () => {
      document.removeEventListener('pointerdown', handleInteraction, true);
      document.removeEventListener('focusin', handleInteraction, true);
    };
  }, []);
}
