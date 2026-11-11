// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getCanvasAccess, listCanvases } from '@/api/canvas';
import useCanvasStore from '@/store/canvasStore';
import { useIdentityStore } from '@/store/identityStore';
import { useWorkspaceStore } from '@/store/workspaceStore';

import { CanvasMenu as CanvasMenuComponent } from './CanvasMenu';

function CanvasMenu() {
  return (
    <MemoryRouter>
      <CanvasMenuComponent />
    </MemoryRouter>
  );
}

vi.mock('@/api/canvas', async (importOriginal) => ({
  ...(await importOriginal()),
  listCanvases: vi.fn(),
  getCanvasAccess: vi.fn(),
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
  useIdentityStore.setState({ identity: null });
  vi.mocked(getCanvasAccess).mockReset();
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
    canvasAccess: null,
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
  it('refreshes permission on foreground and through bounded polling', async () => {
    vi.useFakeTimers();
    try {
      useIdentityStore.setState({
        identity: {
          provider: 'bubble',
          principal: { principalId: 'member', kind: 'user' },
          member: true,
          owner: false,
        },
      });
      vi.mocked(getCanvasAccess).mockResolvedValueOnce({
        write: true,
        manage: true,
      });
      await act(async () => root.render(<CanvasMenu />));
      const input = container.querySelector<HTMLInputElement>('input');
      if (!input) throw new Error('Expected title input');
      expect(input.readOnly).toBe(false);
      vi.mocked(getCanvasAccess).mockResolvedValueOnce({
        write: false,
        manage: false,
      });
      await act(async () => window.dispatchEvent(new Event('focus')));
      expect(input.readOnly).toBe(true);
      vi.mocked(getCanvasAccess).mockResolvedValueOnce({
        write: true,
        manage: true,
      });
      await act(async () => vi.advanceTimersByTimeAsync(15_000));
      expect(input.readOnly).toBe(false);
      expect(getCanvasAccess).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([false, true])(
    'keeps a viewer/editor Space title read-only (write: %s)',
    async (write) => {
      useCanvasStore.setState({
        canvasAccess: { canvasId: 'target', write, manage: false },
      });
      await act(async () => root.render(<CanvasMenu />));
      const input = container.querySelector<HTMLInputElement>('input');
      if (!input) throw new Error('Expected title input');
      expect(input.readOnly).toBe(true);
      await act(async () =>
        input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })),
      );
      expect(tryRename).not.toHaveBeenCalled();
    },
  );

  it('does not commit a title after manage permission is removed', async () => {
    useCanvasStore.setState({
      canvasAccess: { canvasId: 'target', write: true, manage: true },
    });
    await act(async () => root.render(<CanvasMenu />));
    const input = container.querySelector<HTMLInputElement>('input');
    if (!input) throw new Error('Expected title input');
    expect(input.readOnly).toBe(false);
    await act(async () => {
      useCanvasStore.setState({
        canvasAccess: { canvasId: 'target', write: true, manage: false },
      });
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(input.readOnly).toBe(true);
    expect(input.value).toBe('Before');
    expect(tryRename).not.toHaveBeenCalled();
  });

  it('disables both movement actions until names and hierarchy have loaded', async () => {
    let finish!: (value: Awaited<ReturnType<typeof listCanvases>>) => void;
    vi.mocked(listCanvases).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    useWorkspaceStore.setState({
      spaceTitlesStatus: 'idle',
      spaceTitles: {},
      spaceSummaries: { target: { parentSpaceId: 'parent' } },
    });
    await act(async () => root.render(<CanvasMenu />));
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')
        ?.click(),
    );
    const actions = () =>
      [
        ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
      ].filter((button) =>
        ['spaceHierarchy.move', 'spaceHierarchy.moveToTopLevel'].includes(
          button.textContent ?? '',
        ),
      );
    expect(actions()).toHaveLength(2);
    expect(actions().every((button) => button.disabled)).toBe(true);
    await act(async () =>
      finish({
        canvases: [
          {
            canvasId: 'target',
            title: 'Loaded title',
            parentSpaceId: 'parent',
            nodeCount: 2,
            createdAt: 1,
            updatedAt: 1,
          },
          {
            canvasId: 'parent',
            title: 'Parent',
            nodeCount: 1,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
    );
    expect(actions()).toHaveLength(2);
    expect(actions().every((button) => !button.disabled)).toBe(true);
  });

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
