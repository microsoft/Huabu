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
  it('restores fixed measurements with geometry while retaining selection', () => {
    const history = new CanvasHistoryRegistry();
    history.activate('nested-geometry');
    const before: Node = {
      ...node('frame', 0),
      type: 'frame',
      style: { width: 300, height: 200 },
    };
    history.takeSnapshot([before], []);
    const current: Node = {
      ...before,
      selected: true,
      style: { width: 600, height: 400 },
      measured: { width: 590, height: 390 },
    };
    const undo = history.undo([current], []);
    if (!undo) throw new Error('Missing undo snapshot');
    const restored = undo.nodes;
    expect(restored[0]).toMatchObject({
      selected: true,
      measured: { width: 300, height: 200 },
    });
    expect(history.redo(restored, [])?.nodes[0]).toMatchObject({
      selected: true,
      measured: { width: 600, height: 400 },
    });
  });

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

  it("keeps another page's saved content when a local edit is undone or redone", () => {
    const history = new CanvasHistoryRegistry();
    history.activate('remote-content');
    const before: Node = {
      ...node('x', 0),
      data: { content: 'old body', label: 'Old', style: { accent: 'red' } },
    };
    const other = node('y', 0);
    // A local move of x is the undo entry.
    history.takeSnapshot([before, other], []);
    const moved: Node = { ...before, position: { x: 100, y: 0 } };

    // Another page then saves x's body and label.
    const patch = { content: 'body from page A', label: 'From A' };
    history.rebaseRemoteContent('remote-content', 'x', patch);
    const current: Node = { ...moved, data: { ...moved.data, ...patch } };

    const undo = history.undo([current, other], []);
    if (!undo) throw new Error('Missing undo snapshot');
    expect(undo.nodes[0].position).toEqual({ x: 0, y: 0 });
    expect(undo.nodes[0].data).toEqual({
      content: 'body from page A',
      label: 'From A',
      style: { accent: 'red' },
    });
    expect(undo.nodes[1].data).toEqual({});

    // A save that arrives after the undo reaches the redo entry as well.
    history.rebaseRemoteContent('remote-content', 'x', { content: 'again' });
    const redo = history.redo(undo.nodes, []);
    if (!redo) throw new Error('Missing redo snapshot');
    expect(redo.nodes[0].position).toEqual({ x: 100, y: 0 });
    expect(redo.nodes[0].data).toMatchObject({
      content: 'again',
      label: 'From A',
    });
  });
});
