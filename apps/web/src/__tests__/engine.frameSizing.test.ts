// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * @file Executor frame-sizing tests — verifies per-frame `data.sizing`
 *   gates the end-of-batch `fitFrames` pass independently of any
 *   global toggle (which no longer exists post PR 1).
 *
 *   The contract under test:
 *     - `sizing: 'hug'` (or unset, defaulting to hug) → frame refits
 *       to wrap its children after a child geometry change.
 *     - `sizing: 'manual'` → frame keeps its pinned size; the engine
 *       does not touch the frame's `style.width` / `style.height`.
 *     - `options.forceFitFrames: true` → bypasses the per-frame gate
 *       and refits every affected frame (used by agent batches).
 *
 *   Co-located with the web app's vitest suite (instead of inside
 *   `packages/shared`) because the shared package has no test runner
 *   wiring; the test still exercises the published engine surface
 *   through `@huabu/shared/canvas-engine`.
 */

import { describe, expect, it } from 'vitest';

import { executeCanvasCommands } from '@huabu/shared/canvas-engine';

import type { CanvasCommand, CanvasNodeId } from '@huabu/shared';
import type { Node, Edge } from '@xyflow/react';

type FrameSizing = 'hug' | 'manual';

function makeFrame(
  id: string,
  sizing: FrameSizing | undefined,
  rect: { x: number; y: number; w: number; h: number },
): Node {
  return {
    id,
    type: 'frame',
    position: { x: rect.x, y: rect.y },
    style: { width: rect.w, height: rect.h },
    measured: { width: rect.w, height: rect.h },
    data: sizing ? { layoutMode: 'free', sizing } : { layoutMode: 'free' },
  } as Node;
}

function makeChild(
  id: string,
  parentId: string,
  rect: { x: number; y: number; w: number; h: number },
): Node {
  return {
    id,
    type: 'note',
    parentId,
    position: { x: rect.x, y: rect.y },
    style: { width: rect.w, height: rect.h },
    measured: { width: rect.w, height: rect.h },
    data: { content: '' },
  } as Node;
}

/** Read a node's width — the frame's `style.width` is what `fitFrames`
 *  writes to. */
function widthOf(nodes: readonly Node[], id: string): number {
  const node = nodes.find((n) => n.id === id);
  if (!node) throw new Error(`node "${id}" missing`);
  return (node.style as { width?: number } | undefined)?.width ?? -1;
}

describe('executor — per-frame sizing policy', () => {
  it('refits a `hug` frame but leaves a sibling `manual` frame untouched in the same batch', () => {
    // Two siblings, each 500×500 with one 50×50 child positioned near
    // the bottom-right corner. Moving each child to (10, 10) shrinks
    // the would-be bounding box dramatically (well below 500). Only
    // the hug frame should follow.
    const initialFrameWidth = 500;
    const hugFrame = makeFrame('frame-hug', 'hug', {
      x: 0,
      y: 0,
      w: initialFrameWidth,
      h: 500,
    });
    const manualFrame = makeFrame('frame-manual', 'manual', {
      x: 700,
      y: 0,
      w: initialFrameWidth,
      h: 500,
    });
    const hugChild = makeChild('child-hug', hugFrame.id, {
      x: 400,
      y: 400,
      w: 50,
      h: 50,
    });
    const manualChild = makeChild('child-manual', manualFrame.id, {
      x: 400,
      y: 400,
      w: 50,
      h: 50,
    });
    const nodes: Node[] = [hugFrame, manualFrame, hugChild, manualChild];
    const edges: Edge[] = [];

    const commands: CanvasCommand[] = [
      {
        type: 'SET_NODE_GEOMETRY',
        items: [
          {
            nodeId: hugChild.id as CanvasNodeId,
            position: { x: 10, y: 10 },
          },
          {
            nodeId: manualChild.id as CanvasNodeId,
            position: { x: 10, y: 10 },
          },
        ],
      },
    ];

    const { writeResult } = executeCanvasCommands(
      { source: 'ui', commands },
      { nodes, edges, canvasId: 'test' },
    );

    // Hug frame: refit pass shrank `style.width` (new bounding box +
    // padding is well under the initial 500).
    expect(widthOf(writeResult.nodes, hugFrame.id)).toBeLessThan(
      initialFrameWidth,
    );
    // Manual frame: untouched.
    expect(widthOf(writeResult.nodes, manualFrame.id)).toBe(initialFrameWidth);
  });

  it('honours `forceFitFrames` by refitting `manual` frames too', () => {
    const initialFrameWidth = 500;
    const manualFrame = makeFrame('frame-manual', 'manual', {
      x: 0,
      y: 0,
      w: initialFrameWidth,
      h: 500,
    });
    const child = makeChild('child-manual', manualFrame.id, {
      x: 400,
      y: 400,
      w: 50,
      h: 50,
    });
    const nodes: Node[] = [manualFrame, child];

    const commands: CanvasCommand[] = [
      {
        type: 'SET_NODE_GEOMETRY',
        items: [
          {
            nodeId: child.id as CanvasNodeId,
            position: { x: 10, y: 10 },
          },
        ],
      },
    ];

    const { writeResult } = executeCanvasCommands(
      { source: 'agent', commands },
      { nodes, edges: [], canvasId: 'test' },
      { forceFitFrames: true },
    );

    expect(widthOf(writeResult.nodes, manualFrame.id)).toBeLessThan(
      initialFrameWidth,
    );
  });

  it('treats an undefined `sizing` as `hug` (default policy)', () => {
    // Frame without an explicit `data.sizing` field — the engine must
    // refit it on child movement.
    const initialFrameWidth = 500;
    const defaultFrame = makeFrame('frame-default', undefined, {
      x: 0,
      y: 0,
      w: initialFrameWidth,
      h: 500,
    });
    const child = makeChild('child-default', defaultFrame.id, {
      x: 400,
      y: 400,
      w: 50,
      h: 50,
    });
    const nodes: Node[] = [defaultFrame, child];

    const commands: CanvasCommand[] = [
      {
        type: 'SET_NODE_GEOMETRY',
        items: [
          {
            nodeId: child.id as CanvasNodeId,
            position: { x: 10, y: 10 },
          },
        ],
      },
    ];

    const { writeResult } = executeCanvasCommands(
      { source: 'ui', commands },
      { nodes, edges: [], canvasId: 'test' },
    );

    expect(widthOf(writeResult.nodes, defaultFrame.id)).toBeLessThan(
      initialFrameWidth,
    );
  });
});
