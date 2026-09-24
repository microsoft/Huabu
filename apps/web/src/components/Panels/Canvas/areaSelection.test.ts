// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it } from 'vitest';

import { useNodeCollapseStore } from '@/store/nodeCollapseStore';

import { nodesInSelection } from './areaSelection';
import { nodesInMarquee } from './marqueeSelection';

import type { Node, Rect } from '@xyflow/react';

const nodes: Node[] = [
  {
    id: 'frame',
    type: 'frame',
    position: { x: 100, y: 100 },
    measured: { width: 100, height: 100 },
    data: {},
  },
  {
    id: 'nested',
    type: 'frame',
    parentId: 'frame',
    position: { x: 20, y: 20 },
    measured: { width: 50, height: 50 },
    data: {},
  },
  {
    id: 'note',
    type: 'note',
    parentId: 'nested',
    position: { x: 10, y: 10 },
    measured: { width: 20, height: 20 },
    data: {},
  },
];

function polygon(rect: Rect) {
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
}

beforeEach(() => useNodeCollapseStore.setState({ marks: {} }));

describe('shared area selection policy', () => {
  it.each([
    [{ x: 90, y: 90, width: 30, height: 30 }, []],
    [{ x: 140, y: 140, width: 5, height: 5 }, ['note']],
    [{ x: 120, y: 120, width: 50, height: 50 }, ['nested', 'note']],
    [{ x: 100, y: 100, width: 100, height: 100 }, ['frame', 'nested', 'note']],
    [{ x: 100, y: 100, width: 99.99, height: 100 }, ['nested', 'note']],
    [{ x: 150, y: 130, width: 10, height: 10 }, []],
    [{ x: 149.99, y: 130, width: 10, height: 10 }, ['note']],
    [{ x: 130, y: 130, width: 0, height: 20 }, []],
  ] satisfies [Rect, string[]][])(
    'gives rectangle and lasso identical membership for %j',
    (rect, expected) => {
      expect(nodesInMarquee(nodes, rect)).toEqual(expected);
      for (const points of [polygon(rect), polygon(rect).reverse()]) {
        expect(nodesInSelection(nodes, { kind: 'polygon', points })).toEqual(
          expected,
        );
      }
    },
  );

  it('does not select a Frame spanning a concave notch, even when all four corners are inside', () => {
    const points = [
      { x: 90, y: 90 },
      { x: 140, y: 90 },
      { x: 140, y: 160 },
      { x: 160, y: 160 },
      { x: 160, y: 90 },
      { x: 210, y: 90 },
      { x: 210, y: 210 },
      { x: 90, y: 210 },
    ];
    expect(nodesInSelection(nodes, { kind: 'polygon', points })).toEqual([
      'note',
    ]);
  });

  it('uses the visible collapsed mark and excludes hidden/unselectable nodes in both tools', () => {
    useNodeCollapseStore.setState({
      marks: {
        note: {
          cx: 310,
          cy: 310,
          radius: 10,
          progress: 1,
          footprint: { x: 130, y: 130, width: 20, height: 20 },
        },
      },
    });
    const variants = [
      ...nodes,
      { ...nodes[2], id: 'hidden', hidden: true },
      { ...nodes[2], id: 'disabled', selectable: false },
    ];
    for (const rect of [
      { x: 125, y: 125, width: 30, height: 30 },
      { x: 295, y: 295, width: 30, height: 30 },
    ]) {
      const expected = rect.x > 200 ? ['note'] : [];
      expect(nodesInMarquee(variants, rect)).toEqual(expected);
      expect(
        nodesInSelection(variants, { kind: 'polygon', points: polygon(rect) }),
      ).toEqual(expected);
    }
  });

  it('handles crossing edges without captured corners, but rejects a zero-area diagonal', () => {
    const note = { ...nodes[2], parentId: undefined, position: { x: 0, y: 0 } };
    expect(
      nodesInSelection([note], {
        kind: 'polygon',
        points: [
          { x: -10, y: 5 },
          { x: 30, y: 5 },
          { x: 30, y: 15 },
          { x: -10, y: 15 },
        ],
      }),
    ).toEqual(['note']);
    expect(
      nodesInSelection([note], {
        kind: 'polygon',
        points: [
          { x: -10, y: -10 },
          { x: 10, y: 10 },
          { x: 30, y: 30 },
        ],
      }),
    ).toEqual([]);
  });

  it('supports self-crossing lasso lobes without treating their bounding box as full containment', () => {
    const local: Node[] = [
      {
        ...nodes[0],
        position: { x: 0, y: 0 },
        measured: { width: 100, height: 100 },
      },
      {
        ...nodes[2],
        parentId: undefined,
        position: { x: 40, y: 5 },
        measured: { width: 10, height: 10 },
      },
    ];
    expect(
      nodesInSelection(local, {
        kind: 'polygon',
        points: [
          { x: 0, y: 0 },
          { x: 100, y: 100 },
          { x: 0, y: 100 },
          { x: 100, y: 0 },
        ],
      }),
    ).toEqual(['note']);
  });
});
