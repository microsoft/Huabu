// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CanvasConflictError, putNodeContent } from '@/api/canvas';

import useCanvasStore, { drainPendingSaves } from './canvasStore';

import type * as CanvasApi from '@/api/canvas';

vi.mock('@/api/canvasEvents', () => ({
  postCanvasEvents: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('@/api/canvas', async (importActual) => {
  const actual = await importActual<typeof CanvasApi>();
  return {
    ...actual,
    putNodeContent: vi.fn(),
    putCanvas: vi.fn(async (canvasId: string) => ({ canvasId, version: 1 })),
  };
});

describe('User rename ownership and save recovery', () => {
  beforeEach(() => {
    vi.mocked(putNodeContent).mockReset();
    vi.mocked(putNodeContent).mockResolvedValue({
      nodeId: 'question-1',
      label: 'New ink request',
      rev: 'rev-1',
    });
  });

  it('allows navigation after a rejected rename is reverted, preserving concurrent content edits', async () => {
    useCanvasStore.getState()._setStateNoAutosave({
      canvasId: 'canvas-rename-conflict',
      isLoading: false,
      versionConflict: false,
      nodes: [
        {
          id: 'rename-conflict',
          type: 'note',
          position: { x: 0, y: 0 },
          data: {
            content: 'Unsaved body',
            label: 'Original',
            labelSource: 'user',
          },
        },
      ],
      edges: [],
    });
    vi.mocked(putNodeContent).mockRejectedValueOnce(
      new CanvasConflictError({
        code: 'NODE_LABEL_CONFLICT',
        message: 'Name already exists on the server',
      }),
    );
    await expect(
      useCanvasStore.getState().tryRename('node', 'rename-conflict', 'Taken'),
    ).resolves.toBe(false);
    expect(useCanvasStore.getState().nodes[0]?.data).toMatchObject({
      label: 'Original',
      content: 'Unsaved body',
    });
    vi.mocked(putNodeContent).mockClear();
    vi.mocked(putNodeContent).mockResolvedValue({
      nodeId: 'rename-conflict',
      label: 'Original',
      rev: 'saved',
    });
    await expect(
      drainPendingSaves('canvas-rename-conflict'),
    ).resolves.toBeUndefined();
    expect(putNodeContent).toHaveBeenCalledExactlyOnceWith(
      'canvas-rename-conflict',
      'rename-conflict',
      expect.objectContaining({ label: 'Original', content: 'Unsaved body' }),
      undefined,
    );
  });

  it('clears pending inferred naming even for an unchanged user label', async () => {
    useCanvasStore.getState()._setStateNoAutosave({
      canvasId: 'canvas-1',
      nodes: [
        {
          id: 'question-1',
          type: 'question',
          position: { x: 0, y: 0 },
          data: {
            content: '',
            label: 'New ink request',
            pendingInkIntentLabel: true,
          },
        },
      ],
      edges: [],
    });

    await expect(
      useCanvasStore
        .getState()
        .tryRename('node', 'question-1', 'New ink request'),
    ).resolves.toBe(true);

    expect(useCanvasStore.getState().nodes[0]?.data).toMatchObject({
      label: 'New ink request',
      labelSource: 'user',
      pendingInkIntentLabel: false,
    });
    expect(putNodeContent).toHaveBeenCalledOnce();
  });
});
