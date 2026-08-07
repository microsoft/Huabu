// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Interaction suspension for derived-geometry work.
 *
 * A correction that lands mid-gesture moves geometry under the user's
 * hand, so pan, zoom, drag, and resize all hold derived writes until they
 * settle. The counter lives here, apart from the queue that consumes it,
 * for one concrete reason: the gesture handlers live in `canvasStore`,
 * and the queue reads `canvasStore`. Keeping the counter dependency-free
 * breaks what would otherwise be a store ↔ consumer import cycle.
 *
 * Nesting is counted, so overlapping gestures (a node drag begun during a
 * zoom) settle only once the outermost one ends.
 */

type SettleListener = () => void;

export type HeightCommitSuspension = 'viewport' | 'node-drag' | 'node-resize';

const namedHolds = new Set<HeightCommitSuspension>();
let anonymousDepth = 0;
const listeners = new Set<SettleListener>();

/**
 * Hold back derived-geometry writes. Every call must be paired with
 * {@link resumeHeightCommits}.
 */
export function suspendHeightCommits(reason?: HeightCommitSuspension): void {
  if (!reason) {
    anonymousDepth += 1;
    return;
  }
  namedHolds.add(reason);
}

/** Release one hold; notifies listeners when the last one clears. */
export function resumeHeightCommits(reason?: HeightCommitSuspension): void {
  const wasSuspended = isHeightCommitSuspended();
  if (reason) {
    namedHolds.delete(reason);
  } else if (anonymousDepth > 0) anonymousDepth -= 1;
  if (!wasSuspended || isHeightCommitSuspended()) return;
  notifySettled();
}

/** Release named interaction holds after an explicit cancellation signal. */
export function cancelHeightCommitSuspensions(): void {
  const wasSuspended = isHeightCommitSuspended();
  namedHolds.clear();
  if (!wasSuspended || isHeightCommitSuspended()) return;
  notifySettled();
}

/** True while any interaction is in progress. */
export function isHeightCommitSuspended(): boolean {
  return anonymousDepth > 0 || namedHolds.size > 0;
}

/** Run `listener` each time the last active interaction settles. */
export function onHeightCommitsSettled(listener: SettleListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifySettled(): void {
  for (const listener of listeners) listener();
}

/** Test seam: forget all holds. */
export function __resetHeightCommitSuspension(): void {
  anonymousDepth = 0;
  namedHolds.clear();
}
