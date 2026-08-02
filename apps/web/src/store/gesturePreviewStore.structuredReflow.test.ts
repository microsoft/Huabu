/**
 * @file The structured-frame slide-aside preview.
 *
 * The positions deliberately live here rather than on `canvasStore.nodes`:
 * they are re-projected at ~60 fps while a drop is being aimed, and the
 * canvas store is the persisted, undoable, broadcast geometry. Keeping
 * them apart is what makes it impossible for a mid-drag save or history
 * snapshot to capture a position the user never committed.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { useGesturePreviewStore } from './gesturePreviewStore';

const store = () => useGesturePreviewStore.getState();

beforeEach(() => {
  useGesturePreviewStore.getState().resetCanvasScopedTransients();
});

describe('structured reflow positions', () => {
  it('starts empty', () => {
    expect(store().structuredReflowPositions).toBeNull();
  });

  it('keys the projected positions by node id', () => {
    store().setStructuredReflowPositions([
      { id: 'a', x: 10, y: 20 },
      { id: 'b', x: 10, y: 140 },
    ]);

    const positions = store().structuredReflowPositions;
    expect(positions?.get('a')).toEqual({ x: 10, y: 20 });
    expect(positions?.get('b')).toEqual({ x: 10, y: 140 });
  });

  it('leaves the state untouched when a tick projects the same positions', () => {
    store().setStructuredReflowPositions([{ id: 'a', x: 10, y: 20 }]);
    const first = useGesturePreviewStore.getState();

    store().setStructuredReflowPositions([{ id: 'a', x: 10, y: 20 }]);

    // Same state object → subscribers are never notified, so the 60 fps
    // call rate cannot by itself re-render the canvas.
    expect(useGesturePreviewStore.getState()).toBe(first);
  });

  it('publishes a new map as soon as one peer moves', () => {
    store().setStructuredReflowPositions([{ id: 'a', x: 10, y: 20 }]);
    const first = store().structuredReflowPositions;

    store().setStructuredReflowPositions([{ id: 'a', x: 10, y: 60 }]);

    expect(store().structuredReflowPositions).not.toBe(first);
    expect(store().structuredReflowPositions?.get('a')).toEqual({
      x: 10,
      y: 60,
    });
  });

  it('drops a peer that is no longer part of the projection', () => {
    store().setStructuredReflowPositions([
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 0, y: 40 },
    ]);
    store().setStructuredReflowPositions([{ id: 'a', x: 0, y: 0 }]);

    expect(store().structuredReflowPositions?.has('b')).toBe(false);
  });

  it('treats an empty projection as a clear', () => {
    store().setStructuredReflowPositions([{ id: 'a', x: 0, y: 0 }]);
    store().setStructuredReflowPositions([]);

    expect(store().structuredReflowPositions).toBeNull();
  });

  it('restores the real geometry on clear, and clearing twice is free', () => {
    store().setStructuredReflowPositions([{ id: 'a', x: 0, y: 90 }]);
    store().clearStructuredReflowPositions();
    expect(store().structuredReflowPositions).toBeNull();

    const cleared = useGesturePreviewStore.getState();
    store().clearStructuredReflowPositions();
    expect(useGesturePreviewStore.getState()).toBe(cleared);
  });

  it('is dropped by the canvas-scoped transient reset', () => {
    store().setStructuredReflowPositions([{ id: 'a', x: 0, y: 90 }]);
    store().resetCanvasScopedTransients();

    expect(store().structuredReflowPositions).toBeNull();
  });
});
