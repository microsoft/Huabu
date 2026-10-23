// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * @file Tests for `applyStructuredFrameRelayout` per-frame sizing
 * behaviour (PR 2: structured + manual support).
 *
 * The structured solver always re-packs children into tracks. Whether
 * it ALSO writes the frame's own size depends on the frame's
 * `data.sizing`:
 *   • `'hug'` (default) — write content-driven frame size.
 *   • `'manual'`        — leave the user-pinned frame size untouched.
 *
 * These tests pin that contract directly at the solver level so any
 * regression that re-introduces the size write in manual mode (or
 * stops writing it in hug mode) is caught here, independent of the
 * executor or UI layer.
 */

import { describe, it, expect } from 'vitest';

import { structuredFrameResizeScale } from '../../frame/resize.js';
import {
  applyStructuredFrameRelayout,
  solveStructuredFrameLayout,
} from '../gridLayout.js';

import type { Node } from '@xyflow/react';

function makeFrame(
  id: string,
  data: {
    layoutMode: 'free' | 'column' | 'row' | 'grid';
    gridCount?: number;
    sizing?: 'hug' | 'manual';
  },
  style: { width: number; height: number },
): Node {
  return {
    id,
    type: 'frame',
    position: { x: 0, y: 0 },
    data,
    style,
    measured: { width: style.width, height: style.height },
  } as Node;
}

function makeChild(
  id: string,
  parentId: string,
  position: { x: number; y: number },
  size: { width: number; height: number },
): Node {
  return {
    id,
    type: 'text',
    parentId,
    position,
    style: { width: size.width, height: size.height },
    measured: { width: size.width, height: size.height },
    data: {},
  } as Node;
}

function getFrameStyle(
  nodes: Node[],
  id: string,
): {
  width: number;
  height: number;
} {
  const frame = nodes.find((n) => n.id === id);
  if (!frame) throw new Error(`frame "${id}" not found`);
  const s = frame.style as { width: number; height: number } | undefined;
  if (!s) throw new Error(`frame "${id}" has no style`);
  return { width: s.width, height: s.height };
}

describe('applyStructuredFrameRelayout — sizing branch', () => {
  it.each(['column', 'row', 'grid'] as const)(
    'keeps %s gaps and resize inversion stable at every Frame width',
    (layoutMode) => {
      for (const width of [600, 900, 1800, 2400]) {
        const frame = makeFrame(
          'f',
          { layoutMode, gridCount: 2, sizing: 'manual' },
          { width, height: 900 },
        );
        const children = Array.from({ length: 4 }, (_, index) => ({
          ...makeChild(
            `c${index}`,
            'f',
            { x: (index % 2) * 200, y: Math.floor(index / 2) * 100 },
            { width: 100, height: 50 },
          ),
          data: { frameColumn: index % 2, frameRow: Math.floor(index / 2) },
        }));
        const nodes = [frame, ...children];
        const layout = solveStructuredFrameLayout(nodes, 'f');
        if (!layout) throw new Error('Expected structured Frame layout');
        const positions = layout.childPositions;
        expect(positions.get('c0')).toEqual({ x: 20, y: 64 });
        expect(positions.get('c1')).toEqual({
          x: layoutMode === 'row' ? 136 : 144,
          y: 64,
        });
        expect(positions.get('c2')).toEqual({
          x: 20,
          y: layoutMode === 'row' ? 138 : 130,
        });
        expect(layout.frameSize).toEqual({
          width: layoutMode === 'row' ? 256 : 264,
          height: layoutMode === 'row' ? 208 : 200,
        });
        expect(
          structuredFrameResizeScale(
            nodes,
            [],
            'f',
            layout.frameSize.width,
            layout.frameSize.height,
          ),
        ).toEqual({ x: 1, y: 1 });
        const doubled = structuredFrameResizeScale(
          nodes,
          [],
          'f',
          layout.frameSize.width + 200,
          layout.frameSize.height + 100,
        );
        expect(doubled).toEqual({ x: 2, y: 2 });
      }
    },
  );

  it('writes content-driven frame size for hug + column', () => {
    const frame = makeFrame(
      'f',
      { layoutMode: 'column', gridCount: 1, sizing: 'hug' },
      // Intentionally larger than the children would need, so the
      // solver MUST shrink it to prove the write happened.
      { width: 999, height: 999 },
    );
    const child = makeChild(
      'c',
      'f',
      { x: 0, y: 0 },
      { width: 100, height: 50 },
    );
    const { nodes: out, handledFrameIds } = applyStructuredFrameRelayout(
      [frame, child],
      ['f'],
    );
    expect(handledFrameIds.has('f')).toBe(true);
    const after = getFrameStyle(out, 'f');
    // Exact size is padding-dependent, but it must NOT remain 999×999.
    expect(after.width).toBeLessThan(999);
    expect(after.height).toBeLessThan(999);
  });

  it('preserves the user-pinned frame size for manual + column', () => {
    const frame = makeFrame(
      'f',
      { layoutMode: 'column', gridCount: 1, sizing: 'manual' },
      { width: 500, height: 500 },
    );
    const child = makeChild(
      'c',
      'f',
      { x: 0, y: 0 },
      { width: 100, height: 50 },
    );
    const { nodes: out, handledFrameIds } = applyStructuredFrameRelayout(
      [frame, child],
      ['f'],
    );
    expect(handledFrameIds.has('f')).toBe(true);
    // Frame size unchanged — user-pinned 500×500 sticks.
    expect(getFrameStyle(out, 'f')).toEqual({ width: 500, height: 500 });
  });

  it('still re-packs children positions for manual + column', () => {
    // Two children in one column, deliberately placed out of order so
    // the solver has to sort + restack them. The frame is manual, so
    // the frame size must not change — but children positions must.
    const frame = makeFrame(
      'f',
      { layoutMode: 'column', gridCount: 1, sizing: 'manual' },
      { width: 500, height: 500 },
    );
    const a = makeChild(
      'a',
      'f',
      { x: 999, y: 999 },
      { width: 100, height: 50 },
    );
    const b = makeChild('b', 'f', { x: 999, y: 0 }, { width: 100, height: 50 });
    const { nodes: out } = applyStructuredFrameRelayout([frame, a, b], ['f']);
    const aOut = out.find((n) => n.id === 'a')!;
    const bOut = out.find((n) => n.id === 'b')!;
    // Both children now sit at the column's left edge (padX) — NOT at
    // their original x=999.
    expect(aOut.position.x).toBeLessThan(500);
    expect(bOut.position.x).toBeLessThan(500);
    // Solver sorts by y, so `b` (y=0) is stacked above `a` (y=999).
    expect(bOut.position.y).toBeLessThan(aOut.position.y);
    // Frame size still pinned.
    expect(getFrameStyle(out, 'f')).toEqual({ width: 500, height: 500 });
  });

  it('writes content-driven frame size for hug + row', () => {
    const frame = makeFrame(
      'f',
      { layoutMode: 'row', gridCount: 1, sizing: 'hug' },
      { width: 999, height: 999 },
    );
    const child = makeChild(
      'c',
      'f',
      { x: 0, y: 0 },
      { width: 100, height: 50 },
    );
    const { nodes: out } = applyStructuredFrameRelayout([frame, child], ['f']);
    const after = getFrameStyle(out, 'f');
    expect(after.width).toBeLessThan(999);
    expect(after.height).toBeLessThan(999);
  });

  it('preserves the user-pinned frame size for manual + row', () => {
    const frame = makeFrame(
      'f',
      { layoutMode: 'row', gridCount: 1, sizing: 'manual' },
      { width: 600, height: 300 },
    );
    const child = makeChild(
      'c',
      'f',
      { x: 0, y: 0 },
      { width: 100, height: 50 },
    );
    const { nodes: out } = applyStructuredFrameRelayout([frame, child], ['f']);
    expect(getFrameStyle(out, 'f')).toEqual({ width: 600, height: 300 });
  });
});
