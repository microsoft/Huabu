// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  marqueeStartTarget,
  nodesInMarquee,
  rectangleBetween,
} from './marqueeSelection';

import type { Node } from '@xyflow/react';

const nodes: Node[] = [
  {
    id: 'outer',
    type: 'frame',
    position: { x: 100, y: 200 },
    style: { width: 400, height: 300 },
    data: {},
  },
  {
    id: 'inner',
    type: 'frame',
    parentId: 'outer',
    position: { x: 40, y: 50 },
    measured: { width: 100, height: 100 },
    data: {},
  },
  {
    id: 'child',
    type: 'note',
    parentId: 'inner',
    position: { x: 20, y: 20 },
    style: { width: 40, height: 40 },
    data: {},
  },
];

describe('rectangle geometry', () => {
  it('normalizes every drag direction', () => {
    expect(rectangleBetween({ x: 30, y: 50 }, { x: 10, y: 20 })).toEqual({
      x: 10,
      y: 20,
      width: 20,
      height: 30,
    });
  });
  it('selects partial ordinary descendants but never their partially intersected Frames', () => {
    expect(
      nodesInMarquee(nodes, { x: 180, y: 290, width: 30, height: 40 }),
    ).toEqual(['child']);
  });
  it('selects a fully enclosed nested Frame independently of its ancestor', () => {
    expect(
      nodesInMarquee(nodes, { x: 140, y: 250, width: 100, height: 100 }),
    ).toEqual(['inner', 'child']);
  });
  it('retains all Frame and child IDs when fully enclosed (no cardinality normalization)', () => {
    expect(
      nodesInMarquee(nodes, { x: 100, y: 200, width: 400, height: 300 }),
    ).toEqual(['outer', 'inner', 'child']);
  });
  it('toggles Frame inclusion exactly at full containment, in both directions', () => {
    const inside = { x: 100, y: 200, width: 400, height: 300 };
    expect(nodesInMarquee(nodes, inside)).toContain('outer');
    expect(nodesInMarquee(nodes, { ...inside, width: 399.99 })).not.toContain(
      'outer',
    );
    expect(nodesInMarquee(nodes, inside)).toContain('outer');
    expect(nodesInMarquee(nodes, { ...inside, x: 100.01 })).not.toContain(
      'outer',
    );
  });
  it('excludes hidden, unselectable and unmeasured nodes, not merely locked ones', () => {
    const variants = [
      { ...nodes[0], id: 'hidden', hidden: true },
      { ...nodes[0], id: 'unselectable', selectable: false },
      { ...nodes[0], id: 'locked', data: { locked: true } },
      { id: 'unknown', position: { x: 100, y: 200 }, data: {} },
    ];
    expect(
      nodesInMarquee(variants, { x: 0, y: 0, width: 1000, height: 1000 }),
    ).toEqual(['locked']);
  });
  it('uses measured geometry over authored size and rejects zero-area contact', () => {
    const node = {
      ...nodes[0],
      type: 'note',
      measured: { width: 10, height: 10 },
    };
    expect(
      nodesInMarquee([node], { x: 110, y: 200, width: 20, height: 20 }),
    ).toEqual([]);
    expect(
      nodesInMarquee([node], { x: 109.9, y: 200, width: 20, height: 20 }),
    ).toEqual(['outer']);
  });
});

describe('pre-pointerdown target ownership', () => {
  function target(markup: string) {
    const host = document.createElement('div');
    host.innerHTML = `<div class="react-flow__pane">${markup}</div>`;
    return host.querySelector('[data-target]') ?? host.firstElementChild;
  }
  it('accepts pane descendants and blank unselected Frame body', () => {
    expect(
      marqueeStartTarget(target('<div data-target></div>'), nodes),
    ).toEqual({ frameId: null });
    expect(
      marqueeStartTarget(
        target(
          '<div class="react-flow__node react-flow__node-frame" data-id="outer"><div data-target></div></div>',
        ),
        nodes,
      ),
    ).toEqual({ frameId: 'outer' });
  });
  it('leaves an already-selected Frame to native dragging', () => {
    expect(
      marqueeStartTarget(
        target(
          '<div class="react-flow__node" data-id="outer" data-target></div>',
        ),
        nodes.map((n) => ({ ...n, selected: true })),
      ),
    ).toBeNull();
  });

  it('leaves the retained native group-drag overlay above pane/Frames to XYFlow', () => {
    expect(
      marqueeStartTarget(
        target(
          '<div class="react-flow__nodesselection"><div class="react-flow__nodesselection-rect" data-target></div></div>',
        ),
        nodes,
      ),
    ).toBeNull();
  });
  it('uses the closest node, including nested Frame bodies, never an ancestor underneath', () => {
    expect(
      marqueeStartTarget(
        target(
          '<div class="react-flow__node" data-id="outer"><div class="react-flow__node" data-id="child" data-target></div></div>',
        ),
        nodes,
      ),
    ).toBeNull();
    expect(
      marqueeStartTarget(
        target(
          '<div class="react-flow__node" data-id="outer"><div class="react-flow__node" data-id="inner" data-target></div></div>',
        ),
        nodes,
      ),
    ).toEqual({ frameId: 'inner' });
  });
  it.each([
    '<input data-target>',
    '<button data-target>Title</button>',
    '<a data-target href="#">Link</a>',
    '<div contenteditable="true" data-target></div>',
    '<div class="nodrag" data-target></div>',
    '<div class="nokey" data-target></div>',
    '<div class="react-flow__resize-control" data-target></div>',
    '<div class="react-flow__handle" data-target></div>',
    '<div class="react-flow__panel" data-target></div>',
    '<div role="button" data-target></div>',
  ])('preserves control ownership: %s', (markup) => {
    expect(
      marqueeStartTarget(
        target(`<div class="react-flow__node" data-id="outer">${markup}</div>`),
        nodes,
      ),
    ).toBeNull();
  });
});
