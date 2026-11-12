// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  useGesturePreviewStore,
  type StructuredDropPreview,
} from './gesturePreviewStore';

const store = () => useGesturePreviewStore.getState();
const preview = (): StructuredDropPreview => ({
  nodeId: 'node',
  frameId: 'frame',
  kind: 'into-existing',
  x: 20,
  y: 64,
  width: 120,
  height: 80,
  context: {
    axis: 'column',
    tracks: [],
    rows: [],
    activeTrack: 0,
    activeRow: -1,
  },
  masonry: {
    target: { kind: 'into-existing', slot: 0 },
    gap: { slot: 1, x: 140, y: 64, width: 24, height: 200 },
  },
});

beforeEach(() => {
  vi.useFakeTimers();
  store().resetCanvasScopedTransients();
});
afterEach(() => {
  store().resetCanvasScopedTransients();
  vi.useRealTimers();
});

describe('track insertion dwell', () => {
  it.each(['column', 'row'] as const)(
    'arms only the Grid %s axis after 300ms and retains its gap',
    (axis) => {
      const initial = preview();
      initial.context.axis = 'grid';
      if (!initial.masonry?.gap) throw new Error('Missing fixture gap');
      initial.masonry.rowTarget = { kind: 'into-existing', slot: 0 };
      initial.masonry.gap.axis = axis;
      store().setStructuredDropPreview(initial);
      vi.advanceTimersByTime(150);
      store().setStructuredDropPreview({
        ...initial,
        masonry: {
          ...initial.masonry,
          gap: { ...initial.masonry.gap, x: 999 },
        },
      });
      expect(store().structuredDropPreview?.masonry?.gap).toEqual(
        initial.masonry.gap,
      );
      vi.advanceTimersByTime(149);
      expect(store().structuredDropPreview?.kind).toBe('into-existing');
      vi.advanceTimersByTime(1);
      const armed = store().structuredDropPreview?.masonry;
      expect(armed?.target.kind).toBe(
        axis === 'column' ? 'insert-new' : 'into-existing',
      );
      expect(armed?.rowTarget?.kind).toBe(
        axis === 'row' ? 'insert-new' : 'into-existing',
      );
      store().setStructuredDropPreview({
        ...initial,
        masonry: {
          ...initial.masonry,
          gap: { ...initial.masonry.gap, x: 999 },
        },
      });
      expect(store().structuredDropPreview?.masonry).toEqual(armed);
      store().clearStructuredDropPreview();
      vi.advanceTimersByTime(300);
      expect(store().structuredDropPreview).toBeNull();
    },
  );

  it('restarts Grid dwell when switching from a column gap to a row gap', () => {
    const initial = preview();
    initial.context.axis = 'grid';
    if (!initial.masonry?.gap) throw new Error('Missing fixture gap');
    initial.masonry.rowTarget = { kind: 'into-existing', slot: 0 };
    initial.masonry.gap.axis = 'column';
    store().setStructuredDropPreview(initial);
    vi.advanceTimersByTime(250);
    store().setStructuredDropPreview({
      ...initial,
      masonry: {
        ...initial.masonry,
        gap: { ...initial.masonry.gap, axis: 'row' },
      },
    });
    vi.advanceTimersByTime(299);
    expect(store().structuredDropPreview?.kind).toBe('into-existing');
    vi.advanceTimersByTime(1);
    expect(store().structuredDropPreview?.masonry?.rowTarget?.kind).toBe(
      'insert-new',
    );
    expect(store().structuredDropPreview?.masonry?.target.kind).toBe(
      'into-existing',
    );
  });

  it('arms after exactly 300ms without another pointer move or changing geometry', () => {
    const initial = preview();
    store().setStructuredDropPreview(initial);
    vi.advanceTimersByTime(299);
    expect(store().structuredDropPreview?.kind).toBe('into-existing');
    vi.advanceTimersByTime(1);
    expect(store().structuredDropPreview).toEqual({
      ...initial,
      kind: 'insert-new',
      masonry: { ...initial.masonry, target: { kind: 'insert-new', slot: 1 } },
    });
    expect(store().nodeGeometryPreviews).toBeNull();
  });

  it('keeps the timer and armed intent through jitter within the same gap', () => {
    store().setStructuredDropPreview(preview());
    vi.advanceTimersByTime(200);
    store().setStructuredDropPreview({ ...preview(), x: 21 });
    vi.advanceTimersByTime(100);
    expect(store().structuredDropPreview?.kind).toBe('insert-new');
    store().setStructuredDropPreview({ ...preview(), x: 22 });
    expect(store().structuredDropPreview?.masonry?.target).toEqual({
      kind: 'insert-new',
      slot: 1,
    });
  });

  it.each(['gap', 'node', 'frame', 'axis', 'selection'] as const)(
    'restarts the timer after changing %s',
    (change) => {
      store().setStructuredDropPreview(preview());
      vi.advanceTimersByTime(200);
      const next = preview();
      if (change === 'gap' && next.masonry?.gap) next.masonry.gap.slot = 2;
      if (change === 'node') next.nodeId = 'other';
      if (change === 'frame') next.frameId = 'other';
      if (change === 'axis') next.context.axis = 'row';
      if (change === 'selection') next.draggedNodeIds = ['node', 'other'];
      store().setStructuredDropPreview(next);
      vi.advanceTimersByTime(100);
      expect(store().structuredDropPreview?.kind).toBe('into-existing');
      vi.advanceTimersByTime(200);
      expect(store().structuredDropPreview?.kind).toBe('insert-new');
    },
  );

  it.each(['clear', 'reset', 'leave', 'grid'] as const)(
    'cancels pending activation on %s',
    (change) => {
      store().setStructuredDropPreview(preview());
      vi.advanceTimersByTime(200);
      if (change === 'clear') store().clearStructuredDropPreview();
      if (change === 'reset') store().resetCanvasScopedTransients();
      if (change === 'leave') {
        const next = preview();
        if (next.masonry) next.masonry.gap = null;
        store().setStructuredDropPreview(next);
      }
      if (change === 'grid')
        store().setStructuredDropPreview({
          ...preview(),
          masonry: undefined,
          context: { ...preview().context, axis: 'grid' },
        });
      vi.advanceTimersByTime(1000);
      expect(store().structuredDropPreview?.kind).not.toBe('insert-new');
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('withdraws an armed insertion when leaving and requires a full new dwell', () => {
    store().setStructuredDropPreview(preview());
    vi.advanceTimersByTime(300);
    store().clearStructuredDropPreview();
    store().setStructuredDropPreview(preview());
    vi.advanceTimersByTime(299);
    expect(store().structuredDropPreview?.kind).toBe('into-existing');
  });
});
