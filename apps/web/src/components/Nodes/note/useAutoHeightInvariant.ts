// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Development-only invariant: an auto-height note must fit its content.
 *
 * Truncation is a normal state for a *pinned* note — the user chose a box
 * smaller than the text. For an **auto** note it is a defect report: the
 * height was derived from a measurement, so content that does not fit
 * means the measurement disagrees with what the browser actually laid
 * out.
 *
 * Every height bug found so far reduced to exactly that, and every one
 * was found by eye — comparing the bottom whitespace of two notes.
 * The signal was on screen the whole time (the "show all content"
 * chevron); it was simply never labelled as a defect. This labels it.
 *
 * Deliberately delayed and re-read from the DOM rather than fired on the
 * first render that looks short. A correction is asynchronous by design:
 * measure, queue, gate on gestures, commit. Warning before the queue has
 * flushed would report the mechanism working as a failure.
 */

import { useEffect } from 'react';

import { readNoteIntrinsicHeight } from './noteContentHost';

/** Grace period for the measurement to be proposed, queued and committed. */
const SETTLE_MS = 800;

/**
 * Sub-pixel noise plus the quantization step's rounding, which can only
 * ever make the box *larger* than the content.
 */
const TOLERANCE_PX = 1;

export function useAutoHeightInvariant(
  nodeId: string,
  hostRef: React.RefObject<HTMLElement | null>,
  enabled: boolean,
  contentHeight: number,
): void {
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (!enabled || contentHeight <= 0) return;

    const timer = setTimeout(() => {
      const host = hostRef.current;
      if (!host) return;
      const content = readNoteIntrinsicHeight(host);
      const available = host.clientHeight;
      if (available <= 0) return;
      const shortfall = content - available;
      if (shortfall <= TOLERANCE_PX) return;

      console.warn(
        `[height] auto note ${nodeId} is ${Math.round(shortfall)}px short: ` +
          `content ${Math.round(content)}px does not fit ${Math.round(available)}px. ` +
          'Its layout height came from a measurement, so this means the ' +
          'measurement disagrees with what the browser laid out.',
      );
    }, SETTLE_MS);

    return () => clearTimeout(timer);
  }, [contentHeight, enabled, hostRef, nodeId]);
}
