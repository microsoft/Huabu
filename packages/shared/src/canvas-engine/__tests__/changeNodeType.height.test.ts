// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect } from 'vitest';

import { executeCanvasCommands } from '../index.js';

import type { CanvasNode, CanvasEdge } from '../interfaces.js';

const HINT = { intrinsicHeight: 260, measuredFor: '1:abc' };

function run(node: CanvasNode, to: 'text' | 'note') {
  return executeCanvasCommands(
    {
      source: 'ui',
      commands: [{ type: 'CHANGE_NODE_TYPE', nodeId: node.id as never, to }],
    },
    { nodes: [node], edges: [] as CanvasEdge[], canvasId: 'c1' },
  ).writeResult.nodes[0];
}

function dataOf(node: CanvasNode): Record<string, unknown> {
  return node.data as Record<string, unknown>;
}

describe('CHANGE_NODE_TYPE height ownership', () => {
  it('drops the measurement hint when a note becomes text', () => {
    // The hint's reference width and rendering pipeline are constants of
    // the node *type* — deliberately outside the key, because a constant
    // needs no proof. Converting changes the type, so the proof is void
    // in a way nothing downstream could detect.
    const converted = run(
      {
        id: 'n1',
        type: 'note',
        position: { x: 0, y: 0 },
        style: { width: 400, height: 264 },
        measured: { width: 400, height: 264 },
        data: {
          type: 'note',
          content: '**hi**',
          heightMode: 'auto',
          autoHeight: HINT,
        },
      } as CanvasNode,
      'text',
    );

    expect(converted.type).toBe('text');
    expect(dataOf(converted).autoHeight).toBeUndefined();
    // Ownership is meaningless on an always-content type, and a stale
    // flag would be misread if the node is converted back.
    expect(dataOf(converted).heightMode).toBeUndefined();
  });

  it('drops the hint and pins the footprint when text becomes a note', () => {
    const converted = run(
      {
        id: 'n1',
        type: 'text',
        position: { x: 0, y: 0 },
        style: { width: 200 },
        measured: { width: 200, height: 120 },
        data: { type: 'text', content: 'hi', autoHeight: HINT },
      } as CanvasNode,
      'note',
    );

    expect(converted.type).toBe('note');
    expect(dataOf(converted).autoHeight).toBeUndefined();
    // The height is carried over to keep the footprint from moving, so
    // ownership must say `fixed` to match. Left as `auto` with no hint,
    // the node would materialize to the policy minimum and collapse on a
    // conversion whose whole point is that nothing appears to move.
    expect((converted.style as { height?: number }).height).toBe(120);
    expect(dataOf(converted).heightMode).toBe('fixed');
  });
});
