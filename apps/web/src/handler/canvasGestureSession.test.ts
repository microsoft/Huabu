// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, describe, expect, it } from 'vitest';

import {
  beginCanvasGesture,
  cancelPendingCanvasGesture,
  canTouchTakeOverCanvasGesture,
  endCanvasGesture,
  getCanvasGesture,
  getDragActivationDistance,
  resetCanvasGestureForTests,
  updateCanvasGesture,
} from './canvasGestureSession';

describe('canvasGestureSession', () => {
  afterEach(resetCanvasGestureForTests);

  it('uses input-specific screen-space activation distances', () => {
    expect(getDragActivationDistance('mouse')).toBe(1);
    expect(getDragActivationDistance('pen')).toBe(4);
    expect(getDragActivationDistance('touch')).toBe(8);
  });

  it('locks only after the active pointer crosses its threshold', () => {
    expect(beginCanvasGesture('lasso', 1, 'touch', { x: 10, y: 20 })).toBe(
      true,
    );
    expect(updateCanvasGesture(1, { x: 17, y: 20 })).toBe('pending');
    expect(canTouchTakeOverCanvasGesture()).toBe(true);
    expect(updateCanvasGesture(1, { x: 18, y: 20 })).toBe('locked');
    expect(canTouchTakeOverCanvasGesture()).toBe(false);
  });

  it('ignores unrelated pointers and does not replace an active session', () => {
    beginCanvasGesture('sketch-draw', 3, 'pen', { x: 0, y: 0 });

    expect(beginCanvasGesture('lasso', 4, 'touch', { x: 0, y: 0 })).toBe(false);
    expect(updateCanvasGesture(4, { x: 20, y: 0 })).toBeNull();
    expect(endCanvasGesture(4)).toBe(false);
    expect(getCanvasGesture()?.pointerId).toBe(3);
  });

  it('allows takeover to cancel pending but not locked gestures', () => {
    beginCanvasGesture('sketch-erase', 7, 'pen', { x: 0, y: 0 });
    expect(cancelPendingCanvasGesture()).toBe(true);
    expect(getCanvasGesture()).toBeNull();

    beginCanvasGesture('sketch-erase', 8, 'pen', { x: 0, y: 0 });
    updateCanvasGesture(8, { x: 4, y: 0 });
    expect(cancelPendingCanvasGesture()).toBe(false);
    expect(getCanvasGesture()?.phase).toBe('locked');
  });

  it('allows a locked one-finger viewport pan to upgrade to pinch', () => {
    beginCanvasGesture('touch-pan', 9, 'touch', { x: 0, y: 0 });
    updateCanvasGesture(9, { x: 8, y: 0 });

    expect(getCanvasGesture()?.phase).toBe('locked');
    expect(canTouchTakeOverCanvasGesture()).toBe(true);
  });
});
