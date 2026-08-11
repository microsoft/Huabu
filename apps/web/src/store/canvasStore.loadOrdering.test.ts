// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getCanvas, getWorldReferences } = vi.hoisted(() => ({
  getCanvas: vi.fn(),
  getWorldReferences: vi.fn(),
}));

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof CanvasApi>()),
  getCanvas,
  getWorldReferences,
}));

import useCanvasStore, { reloadCanvasWhenSafe } from './canvasStore';
import { useWorkspaceStore } from './workspaceStore';

import type * as CanvasApi from '../api';

function canvasResponse(canvasId: string, title: string, version: number) {
  return {
    canvasId,
    title,
    version,
    structureRevision: `structure-${version}`,
    state: { nodes: [], edges: [] },
  };
}

beforeEach(() => {
  getCanvas.mockReset();
  getWorldReferences.mockReset();
  getWorldReferences.mockResolvedValue({ references: [] });
  useWorkspaceStore.setState({ worldEnabled: false });
  useCanvasStore.getState()._setStateNoAutosave({
    canvasId: 'initial-canvas',
    canvasTitle: 'Initial',
    nodes: [],
    edges: [],
    version: 0,
    structureRevision: 'structure-0',
    structureDirtyGeneration: 1,
    structureSyncedGeneration: 1,
    isLoading: false,
    isSaving: false,
    pendingSave: false,
    versionConflict: false,
    canvasNotFound: false,
  });
});

describe('canvas authoritative load ordering', () => {
  it('does not let an older canvas response replace a newer navigation', async () => {
    let resolveOlder:
      | ((value: ReturnType<typeof canvasResponse>) => void)
      | undefined;
    getCanvas.mockImplementation((canvasId: string) => {
      if (canvasId === 'older-canvas') {
        return new Promise((resolve) => {
          resolveOlder = resolve;
        });
      }
      return Promise.resolve(canvasResponse(canvasId, 'Newer', 2));
    });

    const olderLoad = useCanvasStore
      .getState()
      .loadCanvas('older-canvas', { resetHistory: true });
    await useCanvasStore
      .getState()
      .loadCanvas('newer-canvas', { resetHistory: true });
    resolveOlder?.(canvasResponse('older-canvas', 'Older', 1));
    await olderLoad;

    expect(useCanvasStore.getState()).toMatchObject({
      canvasId: 'newer-canvas',
      canvasTitle: 'Newer',
      version: 2,
      isLoading: false,
    });
  });

  it('does not let an older same-canvas response replace a newer load', async () => {
    let resolveOlder:
      | ((value: ReturnType<typeof canvasResponse>) => void)
      | undefined;
    getCanvas
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOlder = resolve;
          }),
      )
      .mockResolvedValueOnce(canvasResponse('same-canvas', 'Newer', 2));

    const olderLoad = useCanvasStore.getState().loadCanvas('same-canvas');
    await useCanvasStore.getState().loadCanvas('same-canvas');
    resolveOlder?.(canvasResponse('same-canvas', 'Older', 1));
    await olderLoad;

    expect(useCanvasStore.getState()).toMatchObject({
      canvasId: 'same-canvas',
      canvasTitle: 'Newer',
      version: 2,
      isLoading: false,
    });
  });

  it('abandons a gap reload when local nodes change during its GET', async () => {
    let resolveReload:
      | ((value: ReturnType<typeof canvasResponse>) => void)
      | undefined;
    getCanvas.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveReload = resolve;
        }),
    );
    const localNode = {
      id: 'local-note',
      type: 'note' as const,
      position: { x: 0, y: 0 },
      data: { label: 'Local', content: 'before' },
    };
    useCanvasStore.getState()._setStateNoAutosave({
      canvasId: 'same-canvas',
      nodes: [localNode],
      structureDirtyGeneration: 2,
      structureSyncedGeneration: 2,
    });

    const reload = reloadCanvasWhenSafe('same-canvas');
    await vi.waitFor(() => expect(getCanvas).toHaveBeenCalledOnce());
    const editedNode = {
      ...localNode,
      data: { ...localNode.data, content: 'typed during reload' },
    };
    useCanvasStore.getState()._setStateNoAutosave({ nodes: [editedNode] });
    resolveReload?.(canvasResponse('same-canvas', 'Remote', 3));
    await reload;

    expect(useCanvasStore.getState()).toMatchObject({
      canvasId: 'same-canvas',
      canvasTitle: 'Initial',
      version: 0,
      isLoading: false,
    });
    expect(useCanvasStore.getState().nodes).toEqual([editedNode]);
  });

  it('does not regress a newer commit cursor that arrives during a gap GET', async () => {
    let resolveReload:
      | ((value: ReturnType<typeof canvasResponse>) => void)
      | undefined;
    getCanvas.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveReload = resolve;
        }),
    );
    useCanvasStore.getState()._setStateNoAutosave({
      canvasId: 'same-canvas',
      canvasTitle: 'Before stream commit',
      version: 2,
      structureRevision: 'structure-2',
      structureDirtyGeneration: 2,
      structureSyncedGeneration: 2,
    });

    const reload = reloadCanvasWhenSafe('same-canvas');
    await vi.waitFor(() => expect(getCanvas).toHaveBeenCalledOnce());
    useCanvasStore.getState()._setStateNoAutosave({
      canvasTitle: 'Newer stream commit',
      version: 4,
      structureRevision: 'structure-4',
    });
    resolveReload?.(canvasResponse('same-canvas', 'Stale GET', 3));
    await reload;

    expect(useCanvasStore.getState()).toMatchObject({
      canvasTitle: 'Newer stream commit',
      version: 4,
      structureRevision: 'structure-4',
      isLoading: false,
    });
  });
});
