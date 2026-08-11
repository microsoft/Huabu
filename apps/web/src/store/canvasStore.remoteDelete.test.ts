// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import useCanvasStore from './canvasStore';

const nodeId = 'dirty-remote-delete';

beforeEach(() => {
  vi.useFakeTimers();
  useCanvasStore.getState()._setStateNoAutosave({
    canvasId: 'canvas-delete',
    canvasTitle: 'Delete race',
    nodes: [
      {
        id: nodeId,
        type: 'note',
        position: { x: 0, y: 0 },
        data: { label: 'Note', content: 'server baseline' },
      },
    ],
    edges: [],
    version: 1,
    structureRevision: 'structure-1',
    structureDirtyGeneration: 1,
    structureSyncedGeneration: 1,
    isLoading: false,
    isSaving: false,
    pendingSave: false,
    versionConflict: false,
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('dirty remote delete arbitration', () => {
  it('keeps the local body and arms an aggregate topology/content recreate', () => {
    const baseline = useCanvasStore.getState().nodes[0];
    if (!baseline) throw new Error('expected baseline node');
    const dirty = {
      ...baseline,
      data: { ...baseline.data, content: 'unsaved local typing' },
    };
    // Go through Zustand's wrapped setter so the content queue observes the
    // edit exactly as it would from the editor.
    useCanvasStore.setState({ nodes: [dirty] });
    expect(useCanvasStore.getState().pendingContentNodeIds()).toContain(nodeId);

    const skipped = useCanvasStore
      .getState()
      .applyDeltasFromAgent([{ type: 'DELETE_NODE', node: baseline }], 2, {
        mutatedNodes: [],
        deletedNodeIds: [nodeId],
        contentEditedNodeIds: [],
        deferredFitFrameIds: [],
      });

    const state = useCanvasStore.getState();
    expect(skipped).toEqual([nodeId]);
    expect(state.nodes).toEqual([dirty]);
    expect(state.version).toBe(2);
    expect(state.pendingContentNodeIds()).toContain(nodeId);
    expect(state.structureDirtyGeneration).toBeGreaterThan(
      state.structureSyncedGeneration,
    );
  });
});
