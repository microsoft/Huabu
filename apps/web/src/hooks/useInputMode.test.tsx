// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  useInputModeListener,
  useInputModeStore,
  useIsNotMouse,
  usePressSettledIsNotMouse,
} from './useInputMode';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let seen: { live: boolean; settled: boolean };

function Probe() {
  useInputModeListener();
  seen = { live: useIsNotMouse(), settled: usePressSettledIsNotMouse() };
  return null;
}

function pointer(type: string, pointerType: string, pointerId = 1) {
  const event = new Event(type, { bubbles: true });
  Object.assign(event, { pointerType, pointerId });
  act(() => {
    window.dispatchEvent(event);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  useInputModeStore.setState({ mode: 'touch' });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<Probe />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

it('holds the pointer mode through the press that changed it', () => {
  expect(seen).toEqual({ live: true, settled: true });
  // A mouse press flips the live mode at once; chrome positioned by the
  // settled mode must not move while the button is still down.
  pointer('pointerdown', 'mouse');
  expect(seen).toEqual({ live: false, settled: true });
  pointer('pointerup', 'mouse');
  // Still held for the click that the release dispatches in the same task.
  expect(seen.settled).toBe(true);
  act(() => vi.runAllTimers());
  expect(seen).toEqual({ live: false, settled: false });
});

it('adopts a change at once when no pointer is down', () => {
  act(() => {
    useInputModeStore.setState({ mode: 'mouse' });
  });
  act(() => vi.runAllTimers());
  expect(seen).toEqual({ live: false, settled: false });
});

it('releases on a cancelled press as well', () => {
  pointer('pointerdown', 'mouse');
  pointer('pointercancel', 'mouse');
  act(() => vi.runAllTimers());
  expect(seen.settled).toBe(false);
});

it('waits for every pointer when an unrelated one lifts first', () => {
  // A finger rests on the screen, then the mouse presses the chrome.
  pointer('pointerdown', 'touch', 7);
  pointer('pointerdown', 'mouse', 1);
  expect(seen).toEqual({ live: false, settled: true });
  // The finger lifting must not move the chrome under the held mouse.
  pointer('pointerup', 'touch', 7);
  act(() => vi.runAllTimers());
  expect(seen.settled).toBe(true);
  pointer('pointerup', 'mouse', 1);
  act(() => vi.runAllTimers());
  expect(seen.settled).toBe(false);
});

it('does not settle if another press begins before the deferred update', () => {
  pointer('pointerdown', 'mouse', 1);
  pointer('pointerup', 'mouse', 1);
  // A second press lands before the timer runs.
  pointer('pointerdown', 'mouse', 2);
  act(() => vi.runAllTimers());
  expect(seen.settled).toBe(true);
  pointer('pointerup', 'mouse', 2);
  act(() => vi.runAllTimers());
  expect(seen.settled).toBe(false);
});

it('settles after a release that a gesture handler stopped from propagating', () => {
  const target = document.createElement('div');
  document.body.append(target);
  target.addEventListener('pointerup', (event) => event.stopPropagation());
  try {
    pointer('pointerdown', 'mouse', 1);
    expect(seen.settled).toBe(true);
    const release = new Event('pointerup', { bubbles: true });
    Object.assign(release, { pointerType: 'mouse', pointerId: 1 });
    act(() => {
      target.dispatchEvent(release);
    });
    act(() => vi.runAllTimers());
    expect(seen).toEqual({ live: false, settled: false });
  } finally {
    target.remove();
  }
});
