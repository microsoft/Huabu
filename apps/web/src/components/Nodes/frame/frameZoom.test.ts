// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { frameVisualMetricsForSize } from './frameDesign';
import { getFrameHeaderMetrics } from './frameHeaderMetrics';
import {
  farFrameRegionPresentation,
  frameRegionContentBox,
  FRAME_ZOOM_THRESHOLDS,
  resolveFrameZoom,
} from './frameZoom';

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

const AT_ENTER = FRAME_ZOOM_THRESHOLDS.enter;
const ACTIVE_ZOOM = AT_ENTER - 0.001;
const AT_EXIT = FRAME_ZOOM_THRESHOLDS.exit;
const RETAINED_ZOOM = AT_EXIT - 0.001;

describe('Frame region takeover', () => {
  it('uses the configured 8% entry and 10% exit band', () => {
    expect(FRAME_ZOOM_THRESHOLDS).toMatchObject({
      enter: 0.08,
      exit: 0.1,
    });
  });

  it('exposes actual visible region ownership for internal versus cross-region edges', () => {
    const nodes = [
      node('a', 'frame', 1400, 700),
      node('b', 'frame', 1400, 700),
      node('text', 'text', 300, 100, 'a'),
      node('note', 'note', 400, 320, 'a'),
      node('other', 'note', 400, 320, 'b'),
      node('outside', 'note', 400, 320),
    ];
    const state = resolveFrameZoom(nodes, ACTIVE_ZOOM);
    expect(state.regionByNode.get('text')).toBe('a');
    expect(state.regionByNode.get('note')).toBe('a');
    expect(state.regionByNode.get('a')).toBe('a');
    expect(state.regionByNode.get('other')).toBe('b');
    expect(state.regionByNode.has('outside')).toBe(false);
    expect(resolveFrameZoom(nodes, AT_EXIT, state).regionByNode.size).toBe(0);
  });

  it('matches the shared screen budgets and never replaces children with an invisible name', () => {
    expect(
      farFrameRegionPresentation(200, 49, ACTIVE_ZOOM, false),
    ).toMatchObject({
      visible: true,
      fontSize: 10,
      lineHeight: 15,
      lines: 1,
    });
    expect(
      farFrameRegionPresentation(200, 48, ACTIVE_ZOOM, false),
    ).toMatchObject({
      active: true,
      visible: false,
      fallbackVisible: true,
    });
    expect(
      farFrameRegionPresentation(27.9, 100, RETAINED_ZOOM, true),
    ).toMatchObject({
      visible: false,
      fallbackVisible: true,
    });
    expect(
      farFrameRegionPresentation(28, 100, RETAINED_ZOOM, true),
    ).toMatchObject({
      visible: true,
    });
    expect(
      farFrameRegionPresentation(74, 70, RETAINED_ZOOM, true),
    ).toMatchObject({
      visible: true,
      lines: 2,
    });
  });

  it('promotes a marginal nested Frame but keeps it as a best-effort root fallback', () => {
    const inner = node('inner', 'frame', 300, 700);
    const leaf = node('leaf', 'note', 200, 300, 'inner');
    expect([...resolveFrameZoom([inner, leaf], ACTIVE_ZOOM).visible]).toEqual([
      'inner',
    ]);

    const outer = node('outer', 'frame', 1400, 1000);
    inner.parentId = 'outer';
    expect([
      ...resolveFrameZoom([outer, inner, leaf], ACTIVE_ZOOM).visible,
    ]).toEqual(['outer']);
  });

  it('uses the rendered content box for root fallback and standalone playground regions', () => {
    const visual = frameVisualMetricsForSize(440, 728);
    const header = getFrameHeaderMetrics(
      20,
      440,
      visual.titleFontSize,
      visual.headerInset,
    );
    const box = frameRegionContentBox(728 * 0.06, 0.06, header, 15);
    expect(box.availableWidth).toBeCloseTo(24.72);
    expect(box.availableHeight).toBeCloseTo(42.12);
    expect(box.lines).toBe(2);
    const layout = farFrameRegionPresentation(
      440 * 0.06,
      728 * 0.06,
      0.06,
      false,
      header,
    );
    expect(layout.visible).toBe(false);
    expect(layout.fallbackVisible).toBe(true);

    const nodes = [
      node('frame', 'frame', 440, 728),
      node('note', 'note', 240, 180, 'frame'),
    ];
    const state = resolveFrameZoom(nodes, 0.06);
    expect(state.visible.has('frame')).toBe(
      layout.visible || layout.fallbackVisible,
    );
    expect(state.suppressed.has('note')).toBe(true);
    expect(resolveFrameZoom(nodes, AT_EXIT, state).visible.size).toBe(0);
  });

  it('does not claim fallback when the actual header leaves less than one line', () => {
    const header = {
      left: 20,
      top: 500,
      height: 29,
      fontSize: 24,
      maxWidth: 412,
    };
    const layout = farFrameRegionPresentation(26.4, 43.68, 0.06, false, header);
    expect(frameRegionContentBox(43.68, 0.06, header, 15).lines).toBe(0);
    expect(layout.fallbackVisible).toBe(false);
  });

  it('uses all complete lines that fit instead of imposing a fixed line cap', () => {
    for (const [height, lines] of [
      [69, 2],
      [70, 2],
      [90, 4],
      [91, 4],
      [200, 11],
      [448, 28],
    ]) {
      expect(
        farFrameRegionPresentation(200, height, RETAINED_ZOOM, true),
      ).toMatchObject({
        visible: true,
        fontSize: 10,
        lineHeight: 15,
        lines,
      });
    }
  });

  it('keeps single-column Frames readable across a useful zoom range before fit fallback', () => {
    const nodes = [
      node('frame', 'frame', 440, 728),
      node('note', 'note', 400, 644, 'frame'),
    ];
    let state = resolveFrameZoom(nodes, 0.14);
    expect(state.visible.size).toBe(0);
    expect(resolveFrameZoom(nodes, AT_ENTER, state).visible.size).toBe(0);
    for (const zoom of [ACTIVE_ZOOM, 0.07]) {
      state = resolveFrameZoom(nodes, zoom, state);
      expect(state.visible.has('frame')).toBe(true);
      const layout = farFrameRegionPresentation(
        440 * zoom,
        728 * zoom,
        zoom,
        true,
      );
      expect(layout.maxWidth).toBeGreaterThanOrEqual(8);
      expect(layout.fontSize).toBe(10);
    }
    expect(resolveFrameZoom(nodes, 0.069, state).visible.has('frame')).toBe(
      true,
    );
    expect([...resolveFrameZoom(nodes, 0.06, state).visible]).toEqual([
      'frame',
    ]);
    expect(resolveFrameZoom(nodes, 0.02, state).suppressed.size).toBe(0);
    expect(resolveFrameZoom(nodes, AT_EXIT, state).suppressed.size).toBe(0);
  });

  it('uses viewport zoom, preserves geometry, and starts from normal presentation', () => {
    const nodes = [
      node('frame', 'frame', 1400, 700),
      node('small', 'note', 100, 100, 'frame'),
      node('large', 'web', 400, 320, 'frame'),
    ];
    const before = JSON.stringify(nodes);
    let state = resolveFrameZoom(nodes, 0.14);
    expect(state.visible.size).toBe(0);
    state = resolveFrameZoom(nodes, AT_ENTER, state);
    expect(state.visible.size).toBe(0);
    state = resolveFrameZoom(nodes, ACTIVE_ZOOM, state);
    expect([...state.visible]).toEqual(['frame']);
    expect([...state.suppressed]).toEqual(['small', 'large']);
    state = resolveFrameZoom(nodes, RETAINED_ZOOM, state);
    expect(state.visible.has('frame')).toBe(true);
    expect(resolveFrameZoom(nodes, AT_EXIT, state).suppressed.size).toBe(0);
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
      expect(resolveFrameZoom(nodes, AT_ENTER).visible.size).toBe(0);
      const active = resolveFrameZoom(nodes, ACTIVE_ZOOM);
      expect([...active.visible]).toEqual(['frame']);
      expect(
        resolveFrameZoom(nodes, RETAINED_ZOOM, active).visible.has('frame'),
      ).toBe(true);
      expect(resolveFrameZoom(nodes, AT_EXIT, active).visible.size).toBe(0);
    }
  });

  it('hands off at actual title fit, with recovery margin and no gap', () => {
    const nodes = [
      node('outer', 'frame', 1600, 1200),
      node('inner', 'frame', 440, 728, 'outer'),
      node('leaf', 'note', 400, 644, 'inner'),
    ];
    let state = resolveFrameZoom(nodes, ACTIVE_ZOOM);
    expect([...state.visible]).toEqual(['inner']);
    for (const zoom of [0.07]) {
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
      node('inner', 'frame', 800, 700, 'middle'),
      node('leaf', 'note', 400, 300, 'inner'),
      node('mixed', 'note', 1600, 1000, 'outer'),
    ];
    const inner = resolveFrameZoom(nodes, ACTIVE_ZOOM);
    expect([...inner.visible]).toEqual(['inner']);
    const middle = resolveFrameZoom(nodes, 0.069, inner);
    expect([...middle.visible]).toEqual(['middle']);
    expect(middle.suppressed.has('mixed')).toBe(false);
    const outer = resolveFrameZoom(nodes, 0.039, middle);
    expect([...outer.visible]).toEqual(['outer']);
    expect(outer.suppressed.has('mixed')).toBe(true);
    expect([...resolveFrameZoom(nodes, 0.06, outer).visible]).toEqual([
      'middle',
    ]);
    expect([...resolveFrameZoom(nodes, RETAINED_ZOOM, outer).visible]).toEqual([
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
    expect(resolveFrameZoom(nodes, AT_ENTER).visible.has('outer')).toBe(false);
    const state = resolveFrameZoom(nodes, ACTIVE_ZOOM);
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
    expect([...resolveFrameZoom(nodes, ACTIVE_ZOOM).visible]).toEqual([
      'outer',
    ]);
    expect([
      ...resolveFrameZoom([...nodes].reverse(), ACTIVE_ZOOM).visible,
    ]).toEqual(['outer']);
    expect(resolveFrameZoom(nodes, 0.01).suppressed.size).toBe(0);
  });

  it('does not promote when a long title is merely truncated, or when the intermediate Frame is unfit but descendants fit', () => {
    const nodes = [
      node('outer', 'frame', 1800, 1000),
      node('middle', 'frame', 100, 100, 'outer'),
      {
        ...node('inner', 'frame', 800, 700, 'middle'),
        data: { label: 'Long title '.repeat(100) },
      },
      node('leaf', 'note', 200, 100, 'inner'),
    ];
    expect([...resolveFrameZoom(nodes, ACTIVE_ZOOM).visible]).toEqual([
      'inner',
    ]);
  });

  it('paints a region above its descendant band but below the next unrelated node', () => {
    const nodes = [
      { ...node('frame', 'frame', 1400, 700), zIndex: 2 },
      { ...node('child', 'note', 200, 200, 'frame'), zIndex: 3 },
      { ...node('sibling', 'note', 200, 200), zIndex: 4 },
    ];
    expect(resolveFrameZoom(nodes, ACTIVE_ZOOM).regionZ.get('frame')).toBe(3);
    nodes[1].zIndex = 10;
    expect(resolveFrameZoom(nodes, ACTIVE_ZOOM).regionZ.get('frame')).toBe(10);
  });

  it('gives the outer visible Frame priority and restores a nested region independently', () => {
    const nodes = [
      node('outer', 'frame', 1800, 1000),
      node('inner', 'frame', 800, 700, 'outer'),
      node('leaf', 'note', 200, 200, 'inner'),
    ];
    const inner = resolveFrameZoom(nodes, ACTIVE_ZOOM);
    expect([...inner.visible]).toEqual(['inner']);
    expect([...inner.suppressed]).toEqual(['leaf']);
    const outer = resolveFrameZoom(nodes, 0.069, inner);
    expect([...outer.visible]).toEqual(['outer']);
    expect([...outer.suppressed]).toEqual(['inner', 'leaf']);
    expect([...resolveFrameZoom(nodes, RETAINED_ZOOM, outer).visible]).toEqual([
      'inner',
    ]);
    expect([...resolveFrameZoom(nodes, 0.03, outer).visible]).toEqual([
      'outer',
    ]);
    expect(resolveFrameZoom(nodes, 0.01, outer).suppressed.size).toBe(0);
  });

  it('handles empty, missing, hidden and deleted Frames without stale suppression', () => {
    const frame = node('frame', 'frame', 1400, 700);
    const child = node('child', 'note', 200, 200, 'frame');
    const state = resolveFrameZoom([frame, child], ACTIVE_ZOOM);
    expect(state.visible.has('frame')).toBe(true);
    for (const nodes of [
      [frame],
      [child],
      [{ ...frame, hidden: true }, child],
      [{ ...frame, data: { contentMissing: true } }, child],
      [frame, { ...child, hidden: true }],
    ]) {
      expect(resolveFrameZoom(nodes, ACTIVE_ZOOM, state).visible.size).toBe(0);
      expect(resolveFrameZoom(nodes, ACTIVE_ZOOM, state).suppressed.size).toBe(
        0,
      );
    }
  });

  it('ignores content resize, fits measured Frame bounds, and recomputes on reparent independent of node order', () => {
    const frame = node('frame', 'frame', 1400, 700);
    const child = node('child', 'note', 200, 200, 'frame');
    const state = resolveFrameZoom([child, frame], ACTIVE_ZOOM);
    expect(state.suppressed.has('child')).toBe(true);
    expect(
      resolveFrameZoom(
        [frame, { ...child, measured: { width: 800, height: 800 } }],
        AT_ENTER,
        state,
      ).visible.size,
    ).toBe(1);
    expect(
      resolveFrameZoom(
        [{ ...frame, measured: { width: 100, height: 100 } }, child],
        AT_ENTER,
        state,
      ).visible.size,
    ).toBe(0);
    expect(
      resolveFrameZoom(
        [frame, { ...child, parentId: undefined }],
        AT_ENTER,
        state,
      ).visible.size,
    ).toBe(0);
  });
});
