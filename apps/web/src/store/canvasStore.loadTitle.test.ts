// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ getCanvas: vi.fn() }));

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof canvasApi>()),
  ...api,
}));

import { putNodeContent } from '@/api/canvas';

import useCanvasStore from './canvasStore';
import { commitNodeMetadata } from './canvasStore';
import { useToolStore } from './toolStore';

import type * as canvasApi from '../api';
import type * as ContentApi from '@/api/canvas';

vi.mock('@/api/canvas', async (original) => ({
  ...(await original<typeof ContentApi>()),
  putNodeContent: vi.fn(),
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  useCanvasStore.getState()._setStateNoAutosave({
    canvasId: 'previous',
    canvasTitle: 'Previous Space',
    nodes: [],
    edges: [],
    isLoading: false,
    isSaving: false,
    pendingSave: false,
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('canvas title ownership during loading', () => {
  it('passes the canonical loaded PDF revision into the first property save', async () => {
    api.getCanvas.mockResolvedValue({
      canvasId: 'pdf-space',
      title: 'Papers',
      version: 1,
      access: { write: true, manage: true },
      nodeContentRevisions: { pdf: 'canonical-server-revision' },
      state: {
        nodes: [
          {
            id: 'pdf',
            type: 'pdf',
            position: { x: 0, y: 0 },
            data: {
              label: 'Paper',
              src: 'paper.pdf',
              properties: { Venue: 'CHI 25' },
            },
          },
        ],
        edges: [],
      },
    });
    vi.mocked(putNodeContent).mockResolvedValue({
      nodeId: 'pdf',
      label: 'Paper',
      rev: 'saved',
    });
    await useCanvasStore.getState().loadCanvas('pdf-space');
    await commitNodeMetadata('pdf', { properties: { Status: 'Reading' } });
    expect(putNodeContent).toHaveBeenCalledWith(
      'pdf-space',
      'pdf',
      expect.objectContaining({
        expectRev: 'canonical-server-revision',
        properties: { Venue: 'CHI 25', Status: 'Reading' },
      }),
      undefined,
    );
    expect(vi.mocked(putNodeContent).mock.calls[0][2]).not.toHaveProperty(
      'content',
    );
  });

  it('resets tool intent on a direct Space change but preserves preferences and same-Space placement', async () => {
    api.getCanvas.mockResolvedValue({
      canvasId: 'next',
      title: 'Next',
      version: 1,
      state: { nodes: [], edges: [] },
    });
    useToolStore.getState().chooseCanvasTool('pan', false);
    useToolStore.getState().setPendingNodeType('note');
    await useCanvasStore.getState().loadCanvas('next');
    expect(useToolStore.getState()).toMatchObject({
      pendingNodeType: null,
      mouseToolPreference: 'pan',
    });
    useToolStore.getState().setPendingNodeType('text');
    await useCanvasStore.getState().loadCanvas('next');
    expect(useToolStore.getState().pendingNodeType).toBe('text');
  });
  it('clears the outgoing title before fetching and installs the loaded title', async () => {
    let resolve!: (
      value: Awaited<ReturnType<typeof canvasApi.getCanvas>>,
    ) => void;
    api.getCanvas.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );

    const loading = useCanvasStore.getState().loadCanvas('next');
    expect(useCanvasStore.getState()).toMatchObject({
      canvasId: 'next',
      canvasTitle: '',
      isLoading: true,
      pendingSave: false,
    });

    resolve({
      canvasId: 'next',
      title: 'Next Space',
      version: 1,
      access: { write: true, manage: true },
      state: { nodes: [], edges: [] },
    });
    await loading;
    expect(useCanvasStore.getState()).toMatchObject({
      canvasTitle: 'Next Space',
      isLoading: false,
      pendingSave: false,
    });
  });

  it('does not restore the outgoing title after a failed request', async () => {
    const error = new Error('Load failed');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    api.getCanvas.mockRejectedValue(error);
    await useCanvasStore.getState().loadCanvas('next');
    expect(useCanvasStore.getState()).toMatchObject({
      canvasId: 'next',
      canvasTitle: '',
      isLoading: false,
    });
    expect(log).toHaveBeenCalledWith('Failed to load canvas:', error);
  });

  it('retains the current title when reloading the same Space fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    api.getCanvas.mockRejectedValue(new Error('Reload failed'));
    await useCanvasStore.getState().loadCanvas('previous');
    expect(useCanvasStore.getState().canvasTitle).toBe('Previous Space');
  });
});
