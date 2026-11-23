// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { NavigateFunction } from 'react-router-dom';

/** Callers of {@link leaveSpace} waiting for the guard's decision. */
const departures = new Set<(left: boolean) => void>();

/**
 * Settle every pending {@link leaveSpace}. Called only by
 * `SpaceNavigationGuard`, which decides whether a departure happened.
 */
export function settleDepartures(left: boolean): void {
  for (const settle of departures) settle(left);
  departures.clear();
}

/**
 * Leave the open Space for `to` through `SpaceNavigationGuard`, and settle
 * once the guard has decided: `true` when the person is off the Space (its
 * saves drained, or its edits discarded), `false` when they chose to stay.
 * A caller that must not act while the Space is still on screen, such as a
 * Workspace switch, waits for this rather than for `navigate` to return.
 */
export function leaveSpace(
  navigate: NavigateFunction,
  to: string,
): Promise<boolean> {
  const left = new Promise<boolean>((resolve) => departures.add(resolve));
  void navigate(to);
  return left;
}
