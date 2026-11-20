// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createPresencePointerTracker,
  TOUCH_LINGER_MS,
  TOUCH_REPORT_DELAY_MS,
} from './pointerTracker';

type Shown = { x: number; y: number } | null;

function setup() {
  const shown: Shown[] = [];
  const tracker = createPresencePointerTracker((client) => shown.push(client));
  const sample = (pointerType: string, pointerId: number, x = 0, y = 0) => ({
    pointerType,
    pointerId,
    clientX: x,
    clientY: y,
  });
  return { shown, tracker, sample, last: () => shown.at(-1) };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('presence pointer: mouse', () => {
  it('follows the mouse until it leaves the canvas', () => {
    const { shown, tracker, sample } = setup();
    tracker.move(sample('mouse', 1, 10, 20));
    tracker.down(sample('mouse', 1, 11, 21));
    tracker.up(sample('mouse', 1, 11, 21));
    tracker.move(sample('mouse', 1, 30, 40));
    tracker.leave(sample('mouse', 1));

    expect(shown).toEqual([
      { x: 10, y: 20 },
      { x: 11, y: 21 },
      { x: 30, y: 40 },
      null,
    ]);
  });
});

describe('presence pointer: pen', () => {
  it('reports the pen while it hovers and while it is in contact', () => {
    const { shown, tracker, sample } = setup();
    // Hover, on a device that reports it.
    tracker.move(sample('pen', 7, 100, 100));
    // Contact and a stroke.
    tracker.down(sample('pen', 7, 101, 101));
    tracker.move(sample('pen', 7, 140, 120));
    tracker.up(sample('pen', 7, 140, 120));
    // Hover again after lifting.
    tracker.move(sample('pen', 7, 150, 125));

    expect(shown).toEqual([
      { x: 100, y: 100 },
      { x: 101, y: 101 },
      { x: 140, y: 120 },
      { x: 150, y: 125 },
    ]);
  });

  it('clears when the pen goes out of range or off the canvas, including a pen without hover', () => {
    const { shown, tracker, sample, last } = setup();
    // A pen that does not report hover: contact, lift, then the browser's
    // `pointerleave` for a pointer that no longer exists.
    tracker.down(sample('pen', 7, 10, 10));
    tracker.up(sample('pen', 7, 10, 10));
    expect(last()).toEqual({ x: 10, y: 10 });
    tracker.leave(sample('pen', 7));
    expect(last()).toBeNull();
    expect(shown).toHaveLength(2);
  });

  it('ignores the resting hand while the pen is in range', () => {
    const { shown, tracker, sample } = setup();
    tracker.down(sample('pen', 7, 10, 10));
    tracker.down(sample('touch', 3, 400, 400));
    tracker.move(sample('touch', 3, 410, 410));
    vi.advanceTimersByTime(TOUCH_REPORT_DELAY_MS + TOUCH_LINGER_MS);
    tracker.up(sample('touch', 3, 410, 410));
    vi.advanceTimersByTime(TOUCH_LINGER_MS);

    expect(shown).toEqual([{ x: 10, y: 10 }]);
  });
});

describe('presence pointer: touch', () => {
  it('reports the contact point of one finger and follows it', () => {
    const { shown, tracker, sample } = setup();
    tracker.down(sample('touch', 1, 50, 60));
    // Not yet: a second finger may still be on its way.
    tracker.move(sample('touch', 1, 52, 61));
    expect(shown).toEqual([]);

    vi.advanceTimersByTime(TOUCH_REPORT_DELAY_MS);
    expect(shown).toEqual([{ x: 52, y: 61 }]);
    tracker.move(sample('touch', 1, 80, 90));
    expect(shown).toEqual([
      { x: 52, y: 61 },
      { x: 80, y: 90 },
    ]);
  });

  it('keeps the point briefly after the finger lifts, then clears it', () => {
    const { tracker, sample, last } = setup();
    tracker.down(sample('touch', 1, 50, 60));
    vi.advanceTimersByTime(TOUCH_REPORT_DELAY_MS);
    tracker.up(sample('touch', 1, 50, 60));

    vi.advanceTimersByTime(TOUCH_LINGER_MS - 1);
    expect(last()).toEqual({ x: 50, y: 60 });
    vi.advanceTimersByTime(1);
    expect(last()).toBeNull();
  });

  it('shows where a quick tap landed, then clears it', () => {
    const { shown, tracker, sample } = setup();
    tracker.down(sample('touch', 1, 50, 60));
    tracker.up(sample('touch', 1, 51, 60));
    expect(shown).toEqual([{ x: 51, y: 60 }]);

    vi.advanceTimersByTime(TOUCH_LINGER_MS);
    expect(shown).toEqual([{ x: 51, y: 60 }, null]);
  });

  it('keeps the point through the next touch when it lands before the point cleared', () => {
    const { shown, tracker, sample } = setup();
    tracker.down(sample('touch', 1, 50, 60));
    tracker.up(sample('touch', 1, 50, 60));
    vi.advanceTimersByTime(TOUCH_LINGER_MS - 100);
    tracker.down(sample('touch', 2, 70, 80));
    vi.advanceTimersByTime(TOUCH_LINGER_MS);

    // No `null` in between: the earlier clear was cancelled.
    expect(shown).toEqual([
      { x: 50, y: 60 },
      { x: 70, y: 80 },
    ]);
  });

  it('reports nothing during a two-finger pan or pinch', () => {
    const { shown, tracker, sample } = setup();
    tracker.down(sample('touch', 1, 100, 100));
    vi.advanceTimersByTime(TOUCH_REPORT_DELAY_MS / 2);
    tracker.down(sample('touch', 2, 200, 200));
    vi.advanceTimersByTime(TOUCH_REPORT_DELAY_MS * 2);
    tracker.move(sample('touch', 1, 80, 80));
    tracker.move(sample('touch', 2, 240, 240));
    // One finger lifts; the other is still the same gesture.
    tracker.up(sample('touch', 2, 240, 240));
    tracker.move(sample('touch', 1, 60, 60));
    vi.advanceTimersByTime(TOUCH_REPORT_DELAY_MS * 2);
    tracker.up(sample('touch', 1, 60, 60));
    vi.advanceTimersByTime(TOUCH_LINGER_MS);

    expect(shown.filter((client) => client !== null)).toEqual([]);
  });

  it('withdraws a point already shown when a second finger joins, and reports the next single touch', () => {
    const { shown, tracker, sample } = setup();
    tracker.down(sample('touch', 1, 100, 100));
    vi.advanceTimersByTime(TOUCH_REPORT_DELAY_MS);
    tracker.down(sample('touch', 2, 200, 200));
    tracker.move(sample('touch', 1, 90, 90));
    tracker.up(sample('touch', 1, 90, 90));
    tracker.up(sample('touch', 2, 200, 200));
    expect(shown).toEqual([{ x: 100, y: 100 }, null]);

    tracker.down(sample('touch', 3, 300, 300));
    vi.advanceTimersByTime(TOUCH_REPORT_DELAY_MS);
    expect(shown.at(-1)).toEqual({ x: 300, y: 300 });
  });

  it('ignores the end of a touch it never saw start', () => {
    const { shown, tracker, sample } = setup();
    tracker.up(sample('touch', 9, 5, 5));
    tracker.move(sample('touch', 9, 5, 5));
    vi.advanceTimersByTime(TOUCH_LINGER_MS);
    expect(shown).toEqual([]);
  });
});

describe('presence pointer: leaving the page', () => {
  it('clears at once and forgets fingers that were down', () => {
    const { shown, tracker, sample } = setup();
    tracker.down(sample('touch', 1, 50, 60));
    vi.advanceTimersByTime(TOUCH_REPORT_DELAY_MS);
    tracker.reset();
    expect(shown.at(-1)).toBeNull();

    // The lift that follows is not a tap, and nothing fires later.
    tracker.up(sample('touch', 1, 50, 60));
    vi.advanceTimersByTime(TOUCH_LINGER_MS);
    expect(shown).toEqual([{ x: 50, y: 60 }, null]);
  });

  it('reports nothing after it is stopped', () => {
    const { shown, tracker, sample } = setup();
    tracker.down(sample('touch', 1, 50, 60));
    tracker.stop();
    vi.advanceTimersByTime(TOUCH_REPORT_DELAY_MS + TOUCH_LINGER_MS);
    tracker.move(sample('mouse', 2, 1, 1));
    expect(shown).toEqual([]);
  });
});
