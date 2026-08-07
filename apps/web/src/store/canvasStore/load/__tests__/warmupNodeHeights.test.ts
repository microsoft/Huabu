// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, it, expect, vi } from 'vitest';

import { HEIGHT_LAYOUT_VERSION } from '@huabu/shared/canvas-engine';
import { nodeRevisionOf } from '@huabu/shared/canvas-engine';

import { measureNoteHeightOffscreen } from '@/components/Nodes/shared/height/measure/offscreenMeasurer';

import { collectUnmeasured, warmupNodeHeights } from '../warmupNodeHeights';

import type { Edge, Node } from '@xyflow/react';

vi.mock('@/components/Nodes/shared/height/measure/offscreenMeasurer', () => ({
  measureNoteHeightOffscreen: vi.fn(),
}));

const CONTENT = '# hello';
const KEY = `${HEIGHT_LAYOUT_VERSION}:${nodeRevisionOf({ content: CONTENT })}`;
const ORIGIN = { x: 0, y: 0 };
const measureNoteHeight = vi.mocked(measureNoteHeightOffscreen);

function note(overrides: Partial<Node> = {}): Node {
  return {
    id: 'n1',
    type: 'note',
    position: { x: 0, y: 0 },
    style: { width: 400, height: 56 },
    data: { type: 'note', content: CONTENT, heightMode: 'auto' },
    ...overrides,
  } as Node;
}

beforeEach(() => {
  measureNoteHeight.mockReset();
});

describe('collectUnmeasured', () => {
  it('picks up a note that has never been measured', () => {
    expect(collectUnmeasured([note()], ORIGIN)).toMatchObject([
      { nodeId: 'n1', markdown: CONTENT, measuredFor: KEY },
    ]);
  });

  it('leaves a stale hint to the prewarm queue', () => {
    // A stale hint still carries a real number, so the node paints
    // plausibly; only a missing one collapses to the policy minimum and
    // has to be fixed before the canvas is shown.
    const stale = note({
      data: {
        type: 'note',
        content: '# changed since',
        heightMode: 'auto',
        autoHeight: { intrinsicHeight: 260, measuredFor: KEY },
      },
    });
    expect(collectUnmeasured([stale], ORIGIN)).toHaveLength(0);
  });

  it('skips measured notes, pinned notes, and other types', () => {
    const measured = note({
      id: 'measured',
      data: {
        type: 'note',
        content: CONTENT,
        heightMode: 'auto',
        autoHeight: { intrinsicHeight: 260, measuredFor: KEY },
      },
    });
    const pinned = note({
      id: 'pinned',
      data: { type: 'note', content: CONTENT, heightMode: 'fixed' },
    });
    const image = note({ id: 'img', type: 'image', data: { type: 'image' } });
    expect(collectUnmeasured([measured, pinned, image], ORIGIN)).toHaveLength(
      0,
    );
  });

  it('orders by distance from the restored viewport', () => {
    // If the budget runs out it must be the far-away notes that miss it.
    const far = note({ id: 'far', position: { x: 4000, y: 0 } });
    const near = note({ id: 'near', position: { x: 40, y: 0 } });
    expect(collectUnmeasured([far, near], ORIGIN).map((t) => t.nodeId)).toEqual(
      ['near', 'far'],
    );
  });
});

describe('warmupNodeHeights', () => {
  it('preserves graph references when every note is already measured', async () => {
    const nodes = [
      note({
        data: {
          type: 'note',
          content: CONTENT,
          heightMode: 'auto',
          autoHeight: { intrinsicHeight: 260, measuredFor: KEY },
        },
      }),
    ];
    const edges: Edge[] = [];

    const result = await warmupNodeHeights(nodes, {
      canvasId: 'c1',
      edges,
      centre: ORIGIN,
    });

    expect(result.nodes).toBe(nodes);
    expect(result.edges).toBe(edges);
    expect(measureNoteHeight).not.toHaveBeenCalled();
  });

  it('refits a parent hug frame when a measured note grows', async () => {
    measureNoteHeight.mockResolvedValue({
      height: 260,
      provisional: false,
    });
    const frame = {
      id: 'f1',
      type: 'frame',
      position: { x: 0, y: 0 },
      style: { width: 440, height: 120 },
      data: { type: 'frame', layoutMode: 'free', sizing: 'hug' },
    } as Node;
    const child = note({
      parentId: 'f1',
      position: { x: 20, y: 20 },
    });

    const result = await warmupNodeHeights([frame, child], {
      canvasId: 'c1',
      edges: [],
      centre: ORIGIN,
    });

    const warmedChild = result.nodes.find((node) => node.id === 'n1');
    const fittedFrame = result.nodes.find((node) => node.id === 'f1');
    expect(warmedChild?.style?.height).toBe(264);
    expect(fittedFrame?.style?.height).toBeGreaterThan(264);
    expect(fittedFrame?.style?.height).not.toBe(120);
  });
});
