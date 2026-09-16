// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { CanvasHistoryRegistry } from './canvasHistoryManager';

import type { Node } from '@xyflow/react';

function node(id: string, x: number): Node {
  return {
    id,
    type: 'note',
    position: { x, y: 0 },
    data: {},
  };
}

describe('CanvasHistoryRegistry', () => {
  it('undoes editable Question content and geometry while retaining the current FSM', () => {
    const history = new CanvasHistoryRegistry();
    const before: Node = {
      ...node('question', 0),
      type: 'question',
      data: {
        content: 'Before',
        bindingState: 'editing',
        status: 'idle',
        threadId: 'thread',
      },
    };
    history.activate('canvas');
    history.takeSnapshot([before], []);
    const current = {
      ...before,
      position: { x: 20, y: 0 },
      data: {
        ...before.data,
        content: 'After',
        bindingState: 'bound',
        status: 'done',
        invocationToken: 'new',
        viewed: false,
      },
    };
    const restored = history.undo([current], [])?.nodes[0];
    expect(restored).toMatchObject({
      position: { x: 0, y: 0 },
      data: {
        content: 'Before',
        bindingState: 'bound',
        status: 'done',
        invocationToken: 'new',
        viewed: false,
        threadId: 'thread',
      },
    });
    if (!restored) throw new Error('Question was not restored');
    expect(history.redo([restored], [])?.nodes[0]?.data).toMatchObject({
      content: 'After',
      invocationToken: 'new',
      bindingState: 'bound',
    });
  });

  it('ignores legacy topology on undo and redo without losing ordinary child geometry', () => {
    const history = new CanvasHistoryRegistry();
    history.activate('canvas-world');
    const legacy: Node[] = [
      { ...node('portal', 100), type: 'canvasRef' },
      { ...node('pin', 20), type: 'frameRef', parentId: 'portal' },
      { ...node('ref', 30), type: 'nodeRef', parentId: 'pin' },
      { ...node('frame', 5), type: 'frame', parentId: 'pin', extent: 'parent' },
      { ...node('child', 7), parentId: 'frame' },
      { ...node('preview', 400), type: 'spacePreview' },
    ];
    const edges = [
      { id: 'removed', source: 'ref', target: 'child' },
      { id: 'kept', source: 'child', target: 'preview' },
    ];
    const original = JSON.stringify({ nodes: legacy, edges });
    history.takeSnapshot(legacy, edges);
    const undone = history.undo(legacy, edges)!;
    const redone = history.redo(undone.nodes, undone.edges)!;
    for (const restored of [undone, redone]) {
      expect(restored.nodes.map((n) => n.id)).toEqual([
        'frame',
        'child',
        'preview',
      ]);
      expect(restored.nodes[0].position).toEqual({ x: 125, y: 0 });
      expect(restored.nodes[0]).not.toHaveProperty('parentId');
      expect(restored.nodes[0]).not.toHaveProperty('extent');
      expect(restored.nodes[1]).toMatchObject({
        parentId: 'frame',
        position: { x: 7, y: 0 },
      });
      expect(restored.edges).toEqual([edges[1]]);
    }
    expect(JSON.stringify({ nodes: legacy, edges })).toBe(original);
  });

  it('restores independent undo stacks when switching Canvas scopes', () => {
    const history = new CanvasHistoryRegistry();

    history.activate('canvas-world');
    history.takeSnapshot([node('world-note', 0)], []);
    expect(history.canUndo).toBe(true);

    history.activate('canvas-space');
    expect(history.canUndo).toBe(false);
    history.takeSnapshot([node('space-note', 10)], []);

    history.activate('canvas-world');
    expect(history.canUndo).toBe(true);
    expect(
      history.undo([node('world-note', 20)], [])?.nodes[0]?.position,
    ).toEqual({ x: 0, y: 0 });

    history.activate('canvas-space');
    expect(history.canUndo).toBe(true);
  });

  it('clears stale history when reloading the active Canvas', () => {
    const history = new CanvasHistoryRegistry();
    history.activate('canvas-a');
    history.takeSnapshot([node('note-a', 0)], []);

    history.activate('canvas-a', true);

    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
  });
});
