// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { farFrameRegionPresentation, resolveFrameZoom } from './frameZoom';

import type { Node } from '@xyflow/react';

const node = (
  id: string,
  type: string,
  width: number,
  height: number,
  parentId?: string,
): Node => ({
  id,
  type,
  parentId,
  position: { x: 20, y: 64 },
  style: { width, height },
  data: { label: id },
});

describe('Frame region takeover', () => {
  it('exposes actual visible region ownership for internal versus cross-region edges', () => {
    const nodes = [
      node('a', 'frame', 1400, 700),
      node('b', 'frame', 1400, 700),
      node('text', 'text', 300, 100, 'a'),
      node('note', 'note', 400, 320, 'a'),
      node('other', 'note', 400, 320, 'b'),
      node('outside', 'note', 400, 320),
    ];
    const state = resolveFrameZoom(nodes, 0.14);
    expect(state.regionByNode.get('text')).toBe('a');
    expect(state.regionByNode.get('note')).toBe('a');
    expect(state.regionByNode.get('a')).toBe('a');
    expect(state.regionByNode.get('other')).toBe('b');
    expect(state.regionByNode.has('outside')).toBe(false);
    expect(resolveFrameZoom(nodes, 0.2, state).regionByNode.size).toBe(0);
  });

  it('matches the shared screen budgets and never replaces children with an invisible name', () => {
    expect(farFrameRegionPresentation(200, 49, 0.1, false)).toMatchObject({
      visible: true,
      fontSize: 11,
      lineHeight: 16,
      lines: 1,
    });
    expect(farFrameRegionPresentation(200, 48, 0.1, false)).toMatchObject({
      active: true,
      visible: false,
    });
    expect(farFrameRegionPresentation(27.9, 100, 0.1, true).visible).toBe(
      false,
    );
    expect(farFrameRegionPresentation(28, 100, 0.1, true)).toMatchObject({
      visible: true,
    });
    expect(farFrameRegionPresentation(74, 70, 0.1, true)).toMatchObject({
      visible: true,
      lines: 2,
    });
  });

  it('uses all complete lines that fit instead of imposing a fixed line cap', () => {
    for (const [height, lines] of [
      [69, 2],
      [70, 2],
      [90, 3],
      [91, 3],
      [200, 10],
      [448, 26],
    ]) {
      expect(farFrameRegionPresentation(200, height, 0.1, true)).toMatchObject({
        visible: true,
        fontSize: 11,
        lineHeight: 16,
        lines,
      });
    }
  });

  it('keeps single-column Frames readable across a useful zoom range before fit fallback', () => {
    const nodes = [
      node('frame', 'frame', 440, 728),
      node('note', 'note', 400, 644, 'frame'),
    ];
    let state = resolveFrameZoom(nodes, 0.18);
    expect(state.visible.size).toBe(0);
    for (const zoom of [0.14, 0.13, 0.12, 0.1]) {
      state = resolveFrameZoom(nodes, zoom, state);
      expect(state.visible.has('frame')).toBe(true);
      const layout = farFrameRegionPresentation(
        440 * zoom,
        728 * zoom,
        zoom,
        true,
      );
      expect(layout.maxWidth).toBeGreaterThanOrEqual(24);
      expect(layout.fontSize).toBe(11);
    }
    expect(resolveFrameZoom(nodes, 0.09, state).visible.has('frame')).toBe(
      true,
    );
    expect(resolveFrameZoom(nodes, 0.06, state).suppressed.size).toBe(0);
    expect(resolveFrameZoom(nodes, 0.2, state).suppressed.size).toBe(0);
  });

  it('uses viewport zoom, preserves geometry, and starts from normal presentation', () => {
    const nodes = [
      node('frame', 'frame', 1400, 700),
      node('small', 'note', 100, 100, 'frame'),
      node('large', 'web', 400, 320, 'frame'),
    ];
    const before = JSON.stringify(nodes);
    let state = resolveFrameZoom(nodes, 0.18);
    expect(state.visible.size).toBe(0);
    state = resolveFrameZoom(nodes, 0.15, state);
    expect(state.visible.size).toBe(0);
    state = resolveFrameZoom(nodes, 0.149, state);
    expect([...state.visible]).toEqual(['frame']);
    expect([...state.suppressed]).toEqual(['small', 'large']);
    state = resolveFrameZoom(nodes, 0.19, state);
    expect(state.visible.has('frame')).toBe(true);
    expect(resolveFrameZoom(nodes, 0.2, state).suppressed.size).toBe(0);
    expect(JSON.stringify(nodes)).toBe(before);
  });

  it('switches differently sized content at the same scale and ignores hidden child Frames', () => {
    for (const [width, height] of [
      [100, 40],
      [400, 320],
      [1200, 900],
    ]) {
      const nodes = [
        node('frame', 'frame', 1800, 1200),
        node('child', 'note', width, height, 'frame'),
        { ...node('hidden', 'frame', 1800, 1200, 'frame'), hidden: true },
      ];
      expect(resolveFrameZoom(nodes, 0.24).visible.size).toBe(0);
      expect(resolveFrameZoom(nodes, 0.15).visible.size).toBe(0);
      const active = resolveFrameZoom(nodes, 0.149);
      expect([...active.visible]).toEqual(['frame']);
      expect(resolveFrameZoom(nodes, 0.199, active).visible.has('frame')).toBe(
        true,
      );
      expect(resolveFrameZoom(nodes, 0.2, active).visible.size).toBe(0);
    }
  });

  it('hands off at actual title fit, with recovery margin and no gap', () => {
    const nodes = [
      node('outer', 'frame', 1600, 1200),
      node('inner', 'frame', 440, 728, 'outer'),
      node('leaf', 'note', 400, 644, 'inner'),
    ];
    let state = resolveFrameZoom(nodes, 0.14);
    expect([...state.visible]).toEqual(['inner']);
    for (const zoom of [0.12, 0.1, 0.07]) {
      state = resolveFrameZoom(nodes, zoom, state);
      expect([...state.visible]).toEqual(['inner']);
    }
    state = resolveFrameZoom(nodes, 0.067, state);
    expect([...state.visible]).toEqual(['outer']);
    expect(resolveFrameZoom(nodes, 0.069, state).visible.has('outer')).toBe(
      true,
    );
    expect([...resolveFrameZoom(nodes, 0.067).visible]).toEqual(['outer']);
    expect([...resolveFrameZoom(nodes, 0.072, state).visible]).toEqual([
      'inner',
    ]);
  });

  it('aggregates three levels progressively and ignores large mixed non-Frame children', () => {
    const nodes = [
      node('outer', 'frame', 4000, 2600),
      node('middle', 'frame', 1800, 1200, 'outer'),
      node('inner', 'frame', 800, 600, 'middle'),
      node('leaf', 'note', 400, 300, 'inner'),
      node('mixed', 'note', 1600, 1000, 'outer'),
    ];
    const inner = resolveFrameZoom(nodes, 0.14);
    expect([...inner.visible]).toEqual(['inner']);
    const middle = resolveFrameZoom(nodes, 0.079, inner);
    expect([...middle.visible]).toEqual(['middle']);
    expect(middle.suppressed.has('mixed')).toBe(false);
    const outer = resolveFrameZoom(nodes, 0.039, middle);
    expect([...outer.visible]).toEqual(['outer']);
    expect(outer.suppressed.has('mixed')).toBe(true);
    expect([...resolveFrameZoom(nodes, 0.06, outer).visible]).toEqual([
      'middle',
    ]);
    expect([...resolveFrameZoom(nodes, 0.16, outer).visible]).toEqual([
      'inner',
    ]);
  });

  it('promotes a failing measured branch atomically even if a larger sibling still fits', () => {
    const nodes = [
      node('outer', 'frame', 2400, 1600),
      node('small', 'frame', 400, 600, 'outer'),
      {
        ...node('large', 'frame', 400, 300, 'outer'),
        measured: { width: 1200, height: 800 },
      },
      node('smallLeaf', 'note', 200, 100, 'small'),
      node('largeLeaf', 'note', 200, 100, 'large'),
    ];
    expect(resolveFrameZoom(nodes, 0.1).visible.has('outer')).toBe(false);
    const state = resolveFrameZoom(nodes, 0.08);
    expect([...state.visible]).toEqual(['outer']);
    expect(state.suppressed.has('large')).toBe(true);
  });

  it('skips an unfit intermediate Frame to the nearest fitting ancestor independent of node order', () => {
    const nodes = [
      node('outer', 'frame', 1800, 1000),
      node('middle', 'frame', 440, 400, 'outer'),
      node('inner', 'frame', 400, 300, 'middle'),
      node('leaf', 'note', 200, 100, 'inner'),
    ];
    expect([...resolveFrameZoom(nodes, 0.1).visible]).toEqual(['outer']);
    expect([...resolveFrameZoom([...nodes].reverse(), 0.1).visible]).toEqual([
      'outer',
    ]);
    expect(resolveFrameZoom(nodes, 0.01).suppressed.size).toBe(0);
  });

  it('does not promote when a long title is merely truncated, or when the intermediate Frame is unfit but descendants fit', () => {
    const nodes = [
      node('outer', 'frame', 1800, 1000),
      node('middle', 'frame', 100, 100, 'outer'),
      {
        ...node('inner', 'frame', 800, 600, 'middle'),
        data: { label: 'Long title '.repeat(100) },
      },
      node('leaf', 'note', 200, 100, 'inner'),
    ];
    expect([...resolveFrameZoom(nodes, 0.1).visible]).toEqual(['inner']);
  });

  it('paints a region above its descendant band but below the next unrelated node', () => {
    const nodes = [
      { ...node('frame', 'frame', 1400, 700), zIndex: 2 },
      { ...node('child', 'note', 200, 200, 'frame'), zIndex: 3 },
      { ...node('sibling', 'note', 200, 200), zIndex: 4 },
    ];
    expect(resolveFrameZoom(nodes, 0.1).regionZ.get('frame')).toBe(3);
    nodes[1].zIndex = 10;
    expect(resolveFrameZoom(nodes, 0.1).regionZ.get('frame')).toBe(10);
  });

  it('gives the outer visible Frame priority and restores a nested region independently', () => {
    const nodes = [
      node('outer', 'frame', 1800, 1000),
      node('inner', 'frame', 800, 600, 'outer'),
      node('leaf', 'note', 200, 200, 'inner'),
    ];
    const inner = resolveFrameZoom(nodes, 0.14);
    expect([...inner.visible]).toEqual(['inner']);
    expect([...inner.suppressed]).toEqual(['leaf']);
    const outer = resolveFrameZoom(nodes, 0.079, inner);
    expect([...outer.visible]).toEqual(['outer']);
    expect([...outer.suppressed]).toEqual(['inner', 'leaf']);
    expect([...resolveFrameZoom(nodes, 0.12, outer).visible]).toEqual([
      'inner',
    ]);
    expect(resolveFrameZoom(nodes, 0.03, outer).suppressed.size).toBe(0);
  });

  it('handles empty, missing, hidden and deleted Frames without stale suppression', () => {
    const frame = node('frame', 'frame', 1400, 700);
    const child = node('child', 'note', 200, 200, 'frame');
    const state = resolveFrameZoom([frame, child], 0.1);
    expect(state.visible.has('frame')).toBe(true);
    for (const nodes of [
      [frame],
      [child],
      [{ ...frame, hidden: true }, child],
      [{ ...frame, data: { contentMissing: true } }, child],
      [frame, { ...child, hidden: true }],
    ]) {
      expect(resolveFrameZoom(nodes, 0.1, state).visible.size).toBe(0);
      expect(resolveFrameZoom(nodes, 0.1, state).suppressed.size).toBe(0);
    }
  });

  it('ignores content resize, fits measured Frame bounds, and recomputes on reparent independent of node order', () => {
    const frame = node('frame', 'frame', 1400, 700);
    const child = node('child', 'note', 200, 200, 'frame');
    const state = resolveFrameZoom([child, frame], 0.14);
    expect(state.suppressed.has('child')).toBe(true);
    expect(
      resolveFrameZoom(
        [frame, { ...child, measured: { width: 800, height: 800 } }],
        0.15,
        state,
      ).visible.size,
    ).toBe(1);
    expect(
      resolveFrameZoom(
        [{ ...frame, measured: { width: 100, height: 100 } }, child],
        0.15,
        state,
      ).visible.size,
    ).toBe(0);
    expect(
      resolveFrameZoom([frame, { ...child, parentId: undefined }], 0.15, state)
        .visible.size,
    ).toBe(0);
  });
});
