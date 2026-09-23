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
 * The truncation fade exposes the shortfall visually; this labels it.
 *
 * Deliberately delayed and re-read from the DOM rather than fired on the
 * first render that looks short. A correction is asynchronous by design:
 * measure, queue, gate on gestures, commit. Warning before the queue has
 * flushed would report the mechanism working as a failure.
 */

import { useEffect } from 'react';

import { readAutoHeightHint } from '@huabu/shared/canvas-engine';

import useCanvasStore from '@/store/canvasStore';

import { readNoteIntrinsicHeight } from './noteContentHost';
import { isHeightCommitSuspended } from '../shared/height/commitSuspension';

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
  viewportRef: React.RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (!enabled || contentHeight <= 0) return;

    const timer = setTimeout(() => {
      // Width/content changes deliberately retain a stale numeric seed.
      // A held or still-unmeasured correction is not an invariant failure.
      const node = useCanvasStore
        .getState()
        .nodes.find((candidate) => candidate.id === nodeId);
      if (
        isHeightCommitSuspended() ||
        !node ||
        readAutoHeightHint(node).freshness !== 'current'
      )
        return;
      const host = hostRef.current;
      if (!host) return;
      const content = readNoteIntrinsicHeight(host);
      const available = viewportRef.current?.clientHeight ?? 0;
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
  }, [contentHeight, enabled, hostRef, nodeId, viewportRef]);
}
