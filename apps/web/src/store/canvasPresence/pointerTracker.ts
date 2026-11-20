// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Decides which client position this page shows the other pages as its
 * pointer, from mouse, pen and touch pointer events over the canvas.
 *
 *  - Mouse: wherever it moves, until it leaves the canvas.
 *  - Pen: wherever it is, hovering (on devices that report hover) or in
 *    contact, until it leaves the canvas or goes out of range.
 *  - Finger: the contact point of a single touch, from `TOUCH_REPORT_DELAY_MS`
 *    after it lands until `TOUCH_LINGER_MS` after it lifts, so the others see
 *    where the person is working and no cursor stays parked afterwards.
 *  - Two or more fingers are a pan or pinch of this page's own viewport and
 *    are never reported; the gesture stays unreported until every finger of
 *    it has lifted. Touches made while a pen is in range are the resting hand.
 */

/** How long a single touch must be down, alone, before it is reported. */
export const TOUCH_REPORT_DELAY_MS = 80;
/** How long the contact point stays after the finger lifts. */
export const TOUCH_LINGER_MS = 1_500;

export interface PresencePointerSample {
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
}

export interface PresencePointerTracker {
  down(sample: PresencePointerSample): void;
  move(sample: PresencePointerSample): void;
  /** `pointerup` or `pointercancel`. */
  up(sample: PresencePointerSample): void;
  /** The pointer left the canvas (`pointerleave`). */
  leave(sample: Pick<PresencePointerSample, 'pointerType'>): void;
  /** The page lost focus or was hidden: nothing is pointed at any more. */
  reset(): void;
  stop(): void;
}

type ClientPoint = { x: number; y: number };

export function createPresencePointerTracker(
  show: (client: ClientPoint | null) => void,
): PresencePointerTracker {
  const touches = new Map<number, ClientPoint>();
  /** The current touch gesture has had two or more fingers down. */
  let multiTouch = false;
  let penInRange = false;
  let touchDelay: ReturnType<typeof setTimeout> | null = null;
  let linger: ReturnType<typeof setTimeout> | null = null;
  /** The single touch has been down long enough to be reported. */
  let touchShown = false;
  let stopped = false;

  const clearTimer = (timer: ReturnType<typeof setTimeout> | null): null => {
    if (timer !== null) clearTimeout(timer);
    return null;
  };
  const point = (sample: PresencePointerSample): ClientPoint => ({
    x: sample.clientX,
    y: sample.clientY,
  });
  const soleTouch = (): ClientPoint | null =>
    touches.size === 1 ? (touches.values().next().value ?? null) : null;

  const touchDown = (sample: PresencePointerSample): void => {
    touches.set(sample.pointerId, point(sample));
    touchDelay = clearTimer(touchDelay);
    if (touches.size > 1) {
      // A second finger: this is navigation, not pointing.
      if (!multiTouch || touchShown) show(null);
      multiTouch = true;
      touchShown = false;
      linger = clearTimer(linger);
      return;
    }
    if (penInRange || multiTouch) return;
    linger = clearTimer(linger);
    touchShown = false;
    touchDelay = setTimeout(() => {
      touchDelay = null;
      const sole = soleTouch();
      if (!sole || multiTouch || penInRange) return;
      touchShown = true;
      show(sole);
    }, TOUCH_REPORT_DELAY_MS);
  };

  const touchUp = (sample: PresencePointerSample): void => {
    if (!touches.delete(sample.pointerId)) return;
    if (touches.size > 0) return;
    touchDelay = clearTimer(touchDelay);
    if (multiTouch) {
      multiTouch = false;
      touchShown = false;
      return;
    }
    if (!touchShown) {
      // A tap shorter than the delay still shows where it landed.
      if (penInRange) return;
      show(point(sample));
    }
    touchShown = false;
    linger = clearTimer(linger);
    linger = setTimeout(() => {
      linger = null;
      show(null);
    }, TOUCH_LINGER_MS);
  };

  return {
    down(sample) {
      if (stopped) return;
      if (sample.pointerType === 'touch') {
        touchDown(sample);
        return;
      }
      linger = clearTimer(linger);
      if (sample.pointerType === 'pen') penInRange = true;
      show(point(sample));
    },
    move(sample) {
      if (stopped) return;
      if (sample.pointerType === 'touch') {
        if (!touches.has(sample.pointerId)) return;
        touches.set(sample.pointerId, point(sample));
        if (touchShown && !multiTouch && !penInRange) show(point(sample));
        return;
      }
      linger = clearTimer(linger);
      if (sample.pointerType === 'pen') penInRange = true;
      show(point(sample));
    },
    up(sample) {
      if (stopped) return;
      if (sample.pointerType === 'touch') touchUp(sample);
      // A pen or mouse that lifts is still pointing; `leave` ends it.
    },
    leave(sample) {
      if (stopped) return;
      // A finger has no hover: its contact point lingers, then clears.
      if (sample.pointerType === 'touch') return;
      if (sample.pointerType === 'pen') penInRange = false;
      linger = clearTimer(linger);
      show(null);
    },
    reset() {
      if (stopped) return;
      touches.clear();
      multiTouch = false;
      touchShown = false;
      penInRange = false;
      touchDelay = clearTimer(touchDelay);
      linger = clearTimer(linger);
      show(null);
    },
    stop() {
      stopped = true;
      touchDelay = clearTimer(touchDelay);
      linger = clearTimer(linger);
    },
  };
}
