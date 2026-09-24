// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { listCanvases } from '@/api/canvas';
import useCanvasStore from '@/store/canvasStore';
import { useWorkspaceStore } from '@/store/workspaceStore';

import { CanvasMenu } from './CanvasMenu';

vi.mock('@/api/canvas', async (importOriginal) => ({
  ...(await importOriginal()),
  listCanvases: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key }),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const tryRename = vi.fn();

beforeEach(() => {
  tryRename.mockReset();
  vi.mocked(listCanvases)
    .mockReset()
    .mockResolvedValue({
      canvases: [
        {
          canvasId: 'target',
          title: 'Renamed',
          nodeCount: 24,
          createdAt: 1,
          updatedAt: 1234,
        },
      ],
    });
  useCanvasStore.setState({
    canvasId: 'target',
    canvasTitle: 'Before',
    tryRename,
  });
  useWorkspaceStore.setState({
    workspaceId: 'workspace',
    worldCanvasId: null,
    isReady: true,
    isSyncing: false,
    spaceTitles: { target: 'Before' },
    spaceSummaries: { target: { nodeCount: 2, updatedAt: 1 } },
    spaceTitlesStatus: 'ready',
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('CanvasMenu Space metadata', () => {
  it('publishes the current title after an accepted header rename', async () => {
    tryRename.mockImplementationOnce(async () => {
      useCanvasStore.setState({ canvasTitle: 'Renamed' });
      return true;
    });
    await act(async () => root.render(<CanvasMenu />));
    await act(async () => {
      container
        .querySelector('input')
        ?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(tryRename).toHaveBeenCalledWith('canvas', 'target', 'Before');
    expect(useWorkspaceStore.getState().spaceTitles.target).toBe('Renamed');
    expect(useWorkspaceStore.getState().spaceSummaries.target).toEqual({
      nodeCount: 24,
      updatedAt: 1234,
    });
  });

  it('does not publish rejected renames', async () => {
    tryRename.mockResolvedValueOnce(false);
    await act(async () => root.render(<CanvasMenu />));
    await act(async () => {
      container
        .querySelector('input')
        ?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(useWorkspaceStore.getState().spaceTitles.target).toBe('Before');
    expect(listCanvases).not.toHaveBeenCalled();
  });

  it('does not publish a rename that finishes after the workspace changed', async () => {
    tryRename.mockImplementationOnce(async () => {
      useWorkspaceStore.setState({ workspaceId: 'another', spaceTitles: {} });
      useCanvasStore.setState({ canvasTitle: 'Old workspace rename' });
      return true;
    });
    await act(async () => root.render(<CanvasMenu />));
    await act(async () => {
      container
        .querySelector('input')
        ?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(useWorkspaceStore.getState().spaceTitles).toEqual({});
    expect(listCanvases).not.toHaveBeenCalled();
  });
});
