// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useSyncExternalStore } from 'react';

/**
 * Tracks whether the multi-selection modifier (Ctrl / Cmd) is currently
 * held down.
 *
 * React Flow's default `multiSelectionKeyCode` accepts both `Meta` and
 * `Control`, so a user extending a selection may press either. Holding the
 * key is an explicit "I'm about to click *another* node" intent, so any
 * chrome anchored to the current selection (e.g. the single-node floating
 * toolbar) can stand down while it is held to stop occluding the node the
 * user is reaching for.
 *
 * A single global listener set is shared across all subscribers via
 * `useSyncExternalStore`, installed lazily on first subscribe and removed on
 * last unsubscribe — no app-root wiring required.
 */

let held = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function setHeld(next: boolean): void {
  if (held === next) return;
  held = next;
  emit();
}

// Derive purely from the event's modifier flags rather than tracking
// individual key up/down: a `keyup` for Control already reports
// `ctrlKey === false`, so this stays correct even if the down event was
// missed (e.g. the key was pressed while another element had focus).
function syncFromEvent(event: KeyboardEvent): void {
  setHeld(event.metaKey || event.ctrlKey);
}

// Reset when focus leaves the window (Cmd+Tab, Alt+Tab): the matching
// `keyup` is delivered to whichever window gained focus, never to us, so
// the key would otherwise appear stuck-down forever.
function reset(): void {
  setHeld(false);
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    window.addEventListener('keydown', syncFromEvent, true);
    window.addEventListener('keyup', syncFromEvent, true);
    window.addEventListener('blur', reset);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener('keydown', syncFromEvent, true);
      window.removeEventListener('keyup', syncFromEvent, true);
      window.removeEventListener('blur', reset);
    }
  };
}

function getSnapshot(): boolean {
  return held;
}

/** Reactive "is the multi-select modifier (Ctrl / Cmd) held right now?" */
export function useMultiSelectModifierHeld(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
