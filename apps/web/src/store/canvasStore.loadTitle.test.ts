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
import { flushNodeContent } from './canvasStore';
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
  useCanvasStore.getState()._setStateRaw({
    canvasId: 'previous',
    canvasTitle: 'Previous Space',
    nodes: [],
    edges: [],
    isLoading: false,
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('canvas title ownership during loading', () => {
  it('saves a PDF property and a rename without a revision, and quotes the canonical loaded revision when it saves a summary', async () => {
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
    useCanvasStore
      .getState()
      .updateNodeData('pdf', { properties: { Status: 'Reading' } });
    await flushNodeContent('pdf');
    // The one key that changed; no revision, no body, no title.
    const propertySave = vi.mocked(putNodeContent).mock.calls[0][2];
    expect(propertySave).toMatchObject({
      nodeType: 'pdf',
      properties: { Status: 'Reading' },
    });
    expect(Object.keys(propertySave).sort()).toEqual(
      ['nodeType', 'pageId', 'properties'].sort(),
    );

    // A rename is not versioned either: the title alone, no revision.
    useCanvasStore
      .getState()
      .updateNodeData('pdf', { label: 'Paper, final', labelSource: 'user' });
    await flushNodeContent('pdf');
    const titleSave = vi.mocked(putNodeContent).mock.calls[1][2];
    expect(titleSave).toMatchObject({ label: 'Paper, final' });
    expect(titleSave).not.toHaveProperty('expectRev');
    expect(titleSave).not.toHaveProperty('content');
    expect(titleSave).not.toHaveProperty('properties');

    // A save of something derived from the body quotes the revision the
    // load named, not a hash of the node without its extracted text, and
    // not the revision the property or the title save's answer named.
    useCanvasStore.getState().updateNodeData('pdf', { summary: 'A paper.' });
    await flushNodeContent('pdf');
    const summarySave = vi.mocked(putNodeContent).mock.calls[2][2];
    expect(summarySave).toMatchObject({
      summary: 'A paper.',
      expectRev: 'canonical-server-revision',
    });
    expect(summarySave).not.toHaveProperty('label');
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
