// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  putCanvas: vi.fn(),
  putNodeContent: vi.fn(),
  preprocessNode: vi.fn(),
  postCanvasEvents: vi.fn(),
}));
vi.mock('../api', async (actual) => ({
  ...(await actual<typeof apiModule>()),
  ...api,
}));
vi.mock('../api/canvas', async (actual) => ({
  ...(await actual<typeof canvasApiModule>()),
  ...api,
}));
vi.mock('@/components/Common/Toast', () => ({ toast: vi.fn() }));

import useCanvasStore, {
  hasUnsavedCanvasEdits,
  savedBeforeSignOut,
} from './canvasStore';
import { pageLifecycle } from '../utils/pageLifecycle';

import type * as apiModule from '../api';
import type * as canvasApiModule from '../api/canvas';
import type { Node } from '@xyflow/react';

const note: Node = {
  id: 'node-signout-note',
  type: 'note',
  position: { x: 0, y: 0 },
  style: { width: 300, height: 200 },
  data: { type: 'note', content: 'Saved body', label: 'Note' },
};
const state = () => useCanvasStore.getState();

// Only transport is substituted; the store, its queues and their failure
// bookkeeping are real.
beforeEach(() => {
  vi.clearAllMocks();
  api.putCanvas.mockImplementation(async (canvasId: string) => ({
    canvasId,
    version: 2,
  }));
  api.preprocessNode.mockResolvedValue({ success: true });
  api.postCanvasEvents.mockResolvedValue({ ok: true });
  state()._setStateNoAutosave({
    canvasId: 'signout-canvas',
    canvasTitle: 'Sign-out',
    nodes: [note],
    edges: [],
    version: 1,
    isLoading: false,
    isSaving: false,
    pendingSave: false,
    versionConflict: false,
    versionConflictServerVersion: null,
  });
});

describe('savedBeforeSignOut', () => {
  it('reports an edit whose content save failed as unsaved', async () => {
    api.putNodeContent.mockRejectedValue(new Error('Internal Server Error'));
    state().updateNodeData(note.id, { content: 'Typed just before sign-out' });
    expect(await savedBeforeSignOut()).toBe(false);
    expect(api.putNodeContent).toHaveBeenCalled();
  });

  it('stops a recording and awaits an upload before the last saves', async () => {
    api.putNodeContent.mockImplementation(async () => ({ revision: 'r2' }));
    const settle = vi.fn();
    const unregister = pageLifecycle.register('audio:signout', { settle });
    let finishUpload!: () => void;
    let uploaded = false;
    void pageLifecycle.run(
      'importing',
      () =>
        new Promise<void>((resolve) => {
          finishUpload = () => {
            // The upload's node arrives only when it finishes.
            state().updateNodeData(note.id, { content: 'Uploaded text' });
            uploaded = true;
            resolve();
          };
        }),
    );
    try {
      const saved = savedBeforeSignOut();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settle).toHaveBeenCalled();
      expect(api.putNodeContent).not.toHaveBeenCalled();
      finishUpload();
      expect(await saved).toBe(true);
      expect(uploaded).toBe(true);
      expect(api.putNodeContent).toHaveBeenLastCalledWith(
        'signout-canvas',
        note.id,
        expect.objectContaining({ content: 'Uploaded text' }),
        undefined,
      );
    } finally {
      unregister();
    }
  });

  it('confirms once the content save landed', async () => {
    api.putNodeContent.mockImplementation(async () => ({ revision: 'r2' }));
    state().updateNodeData(note.id, { content: 'Typed just before sign-out' });
    expect(await savedBeforeSignOut()).toBe(true);
    expect(api.putNodeContent).toHaveBeenCalled();
  });
});

describe('hasUnsavedCanvasEdits', () => {
  it('counts a queued, then a failed, content edit until one lands', async () => {
    expect(hasUnsavedCanvasEdits()).toBe(false);
    api.putNodeContent.mockRejectedValue(new Error('401 IDENTITY_REQUIRED'));
    state().updateNodeData(note.id, { content: 'Typed as the session lapsed' });
    expect(hasUnsavedCanvasEdits()).toBe(true);
    await savedBeforeSignOut();
    expect(hasUnsavedCanvasEdits()).toBe(true);

    api.putNodeContent.mockImplementation(async () => ({ revision: 'r3' }));
    state().updateNodeData(note.id, { content: 'Typed once signed in again' });
    expect(await savedBeforeSignOut()).toBe(true);
    expect(hasUnsavedCanvasEdits()).toBe(false);
  });
});
