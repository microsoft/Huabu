// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The undo and redo buttons read `canUndo` / `canRedo` from the store. An
 * update from the server can add an undo entry (an Agent's edit is
 * everyone's to undo), so the flags have to follow it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { canvasHistoryManager } from './canvasHistoryManager';
import useCanvasStore from './canvasStore';

import type { Delta } from '@huabu/shared/canvas-engine';
import type { Node } from '@xyflow/react';

const frame = (x: number): Node => ({
  id: 'frame-1',
  type: 'frame',
  position: { x, y: 0 },
  style: { width: 200, height: 100 },
  data: { type: 'frame', label: 'Frame' },
});

const pendingEffects = {
  mutatedNodeIds: [],
  deletedNodeIds: [],
  contentEditedNodeIds: [],
  deferredFitFrameIds: [],
};

const moved: Delta[] = [
  { type: 'REPLACE_NODE', prev: frame(0), next: frame(300) },
];

beforeEach(() => {
  vi.useFakeTimers();
  canvasHistoryManager.activate('canvas-undo-flags', true);
  useCanvasStore.getState()._setStateRaw({
    canvasId: 'canvas-undo-flags',
    nodes: [frame(0)],
    edges: [],
    version: 1,
    isLoading: false,
    canUndo: false,
    canRedo: false,
  });
});

afterEach(() => {
  useCanvasStore.setState({ nodes: [] });
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('undo availability after an update from the server', () => {
  it("is on once an Agent's edit has been applied", () => {
    useCanvasStore
      .getState()
      .applyServerDeltas(moved, 2, pendingEffects, false, { source: 'agent' });
    expect(useCanvasStore.getState().nodes[0].position.x).toBe(300);
    expect(canvasHistoryManager.canUndo).toBe(true);
    expect(useCanvasStore.getState().canUndo).toBe(true);
  });

  it("stays off after another person's edit, which is theirs to undo", () => {
    useCanvasStore
      .getState()
      .applyServerDeltas(moved, 2, pendingEffects, false, { source: 'ui' });
    expect(useCanvasStore.getState().nodes[0].position.x).toBe(300);
    expect(useCanvasStore.getState().canUndo).toBe(false);
  });
});
