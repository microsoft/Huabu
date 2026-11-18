// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  diffSiblingOrderEvents,
  type CanvasNode,
  type Delta,
  type SetSiblingOrderEvent,
} from '@huabu/shared/canvas-engine';

import { canvasHistoryManager } from './canvasHistoryManager';
import useCanvasStore from './canvasStore';
import { contentRevisionsOf } from './canvasStore/sync/testing/contentRevisions';

import type { Node } from '@xyflow/react';

const pendingEffects = {
  mutatedNodeIds: [],
  deletedNodeIds: [],
  contentEditedNodeIds: [],
  deferredFitFrameIds: [],
};

const note = (id: string, parentId?: string): Node => ({
  id,
  type: 'note',
  position: { x: 0, y: 0 },
  ...(parentId ? { parentId, zIndex: -1 } : {}),
  data: { type: 'note', label: id },
});

const frame = (id: string): Node => ({
  id,
  type: 'frame',
  position: { x: 0, y: 0 },
  style: { width: 300, height: 300 },
  data: { type: 'frame', label: id, sizing: 'manual' },
});

/** The events a server commit from `before` to `after` sends, as received. */
function wireEvents(before: Node[], after: Node[]): SetSiblingOrderEvent[] {
  return JSON.parse(
    JSON.stringify(
      diffSiblingOrderEvents(before as CanvasNode[], after as CanvasNode[], 2),
    ),
  );
}

const ids = (): string[] => useCanvasStore.getState().nodes.map((n) => n.id);

function seed(nodes: Node[]): void {
  useCanvasStore.getState()._setStateRaw({
    canvasId: 'canvas-1',
    nodes,
    edges: [],
    version: 1,
    isLoading: false,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  canvasHistoryManager.activate('canvas-1', true);
});

afterEach(() => {
  // A plain setState would schedule a structure save that outlives the
  // cleared timers and reads as an unsaved edit in the next test.
  useCanvasStore.getState()._setStateRaw({
    nodes: [],
  });
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('sibling order from a server update', () => {
  it('installs the order of a pure reorder that carries no deltas', () => {
    const before = [note('a'), note('b'), note('c')];
    seed(before);
    const onDiverged = vi.fn();

    useCanvasStore.getState().applyServerDeltas([], 2, pendingEffects, false, {
      events: wireEvents(before, [before[1], before[2], before[0]]),
      onDiverged,
    });

    expect(ids()).toEqual(['b', 'c', 'a']);
    expect(useCanvasStore.getState().version).toBe(2);
    expect(onDiverged).not.toHaveBeenCalled();
    expect(canvasHistoryManager.canUndo).toBe(true);
  });

  it('reorders the children of a Frame and keeps each subtree contiguous', () => {
    const before = [frame('f'), note('x', 'f'), note('y', 'f'), note('a')];
    seed(before);

    useCanvasStore.getState().applyServerDeltas([], 2, pendingEffects, false, {
      events: wireEvents(before, [before[3], before[0], before[2], before[1]]),
    });

    expect(ids()).toEqual(['a', 'f', 'y', 'x']);
  });

  it('places a created node where the server placed it', () => {
    const before = [note('a'), note('b')];
    const created = note('n');
    seed(before);
    const deltas = [{ type: 'INSERT_NODE', node: created }] as Delta[];

    useCanvasStore
      .getState()
      .applyServerDeltas(
        deltas,
        2,
        pendingEffects,
        false,
        { events: wireEvents(before, [before[0], created, before[1]]) },
        { nodeContentRevisions: contentRevisionsOf(deltas) },
      );

    expect(ids()).toEqual(['a', 'n', 'b']);
  });

  it('accepts a creation whose node already exists locally', () => {
    const before = [note('a'), note('b')];
    const created = note('n');
    seed([...before, created]);
    const onDiverged = vi.fn();

    useCanvasStore.getState().applyServerDeltas(
      [{ type: 'INSERT_NODE', node: created }] as Delta[],
      2,
      pendingEffects,
      false,
      { events: wireEvents(before, [...before, created]), onDiverged },
      {
        nodeContentRevisions: contentRevisionsOf([
          { type: 'INSERT_NODE', node: created },
        ] as Delta[]),
      },
    );

    expect(ids()).toEqual(['a', 'b', 'n']);
    expect(onDiverged).not.toHaveBeenCalled();
  });

  it('keeps the entity-only result and asks for a reload when the order cannot be installed', () => {
    seed([note('b'), note('a'), note('c')]);
    const serverBefore = [note('a'), note('b'), note('c')];
    const onDiverged = vi.fn();

    useCanvasStore.getState().applyServerDeltas([], 2, pendingEffects, false, {
      events: wireEvents(serverBefore, [
        serverBefore[2],
        serverBefore[0],
        serverBefore[1],
      ]),
      onDiverged,
    });

    expect(ids()).toEqual(['b', 'a', 'c']);
    expect(useCanvasStore.getState().version).toBe(2);
    expect(onDiverged).toHaveBeenCalledOnce();
  });

  it('does not ask for a reload when the local order already is the server order', () => {
    seed([note('c'), note('a'), note('b')]);
    const serverBefore = [note('a'), note('b'), note('c')];
    const onDiverged = vi.fn();

    useCanvasStore.getState().applyServerDeltas([], 2, pendingEffects, false, {
      events: wireEvents(serverBefore, [
        serverBefore[2],
        serverBefore[0],
        serverBefore[1],
      ]),
      onDiverged,
    });

    expect(ids()).toEqual(['c', 'a', 'b']);
    expect(onDiverged).not.toHaveBeenCalled();
  });

  it('does not ask for a reload over unsaved local edits', () => {
    seed([note('b'), note('a'), note('c')]);
    // A body the content save has not sent yet.
    useCanvasStore.getState().updateNodeData('a', { content: 'Unsaved' });
    const serverBefore = [note('a'), note('b'), note('c')];
    const onDiverged = vi.fn();

    useCanvasStore.getState().applyServerDeltas([], 2, pendingEffects, false, {
      events: wireEvents(serverBefore, [
        serverBefore[2],
        serverBefore[0],
        serverBefore[1],
      ]),
      onDiverged,
    });

    expect(ids()).toEqual(['b', 'a', 'c']);
    expect(onDiverged).not.toHaveBeenCalled();
  });

  it('leaves an update without order events exactly as before', () => {
    seed([note('a'), note('b')]);

    useCanvasStore.getState().applyServerDeltas([], 2, pendingEffects);

    expect(ids()).toEqual(['a', 'b']);
    expect(useCanvasStore.getState().version).toBe(2);
    expect(canvasHistoryManager.canUndo).toBe(false);
  });
});
