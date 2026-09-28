// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { listCanvases } from '@/api/canvas';
import { useWorkspaceStore } from '@/store/workspaceStore';

import {
  useSpaceShortcutTarget,
  type SpaceShortcutTarget,
} from './useSpaceShortcutTarget';

vi.mock('@/api/canvas', () => ({ listCanvases: vi.fn() }));
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key }),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const targets = new Map<string, SpaceShortcutTarget>();

function Target({ id }: { id: string }) {
  targets.set(id, useSpaceShortcutTarget(id));
  return null;
}

beforeEach(() => {
  vi.mocked(listCanvases).mockReset();
  targets.clear();
  useWorkspaceStore.setState({
    workspaceId: 'workspace',
    workspacePath: '/workspaces/active',
    isReady: true,
    isSyncing: false,
    spaceTitles: {},
    spaceSummaries: {},
    spaceTitlesStatus: 'idle',
    spaceTitlesError: null,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('useSpaceShortcutTarget', () => {
  it('keeps confirmed targets ready during refresh and disables a confirmed deletion afterwards', async () => {
    useWorkspaceStore.setState({
      spaceTitles: { target: 'Known target' },
      spaceSummaries: { target: { nodeCount: 24, updatedAt: 1234 } },
      spaceTitlesStatus: 'ready',
    });
    let finish!: (response: Awaited<ReturnType<typeof listCanvases>>) => void;
    vi.mocked(listCanvases).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await act(async () =>
      root.render(
        <>
          <Target id="target" />
          <Target id="unknown" />
        </>,
      ),
    );
    let refresh: Promise<void>;
    await act(async () => {
      refresh = useWorkspaceStore.getState().refreshSpaceTitles();
    });
    expect(targets.get('target')?.status).toBe('ready');
    expect(targets.get('target')).toMatchObject({
      nodeCount: 24,
      updatedAt: 1234,
    });
    expect(targets.get('unknown')?.status).toBe('loading');
    await act(async () => {
      finish({ canvases: [] });
      await refresh;
    });
    expect(targets.get('target')?.status).toBe('missing');
    expect(targets.get('target')?.nodeCount).toBeUndefined();
  });

  it('publishes a confirmed new target immediately and retains it against an older pending list', async () => {
    let finish!: (response: Awaited<ReturnType<typeof listCanvases>>) => void;
    vi.mocked(listCanvases).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await act(async () => root.render(<Target id="new-target" />));
    act(() =>
      useWorkspaceStore
        .getState()
        .setSpaceTitle('new-target', 'Created destination'),
    );
    expect(targets.get('new-target')).toMatchObject({
      title: 'Created destination',
      status: 'ready',
    });
    expect(targets.get('new-target')?.nodeCount).toBeUndefined();
    await act(async () => {
      finish({ canvases: [] });
    });
    expect(targets.get('new-target')?.status).toBe('ready');
  });

  it('retains navigation after a failed background refresh while exposing the error', async () => {
    useWorkspaceStore.setState({
      spaceTitles: { target: 'Known target' },
      spaceTitlesStatus: 'ready',
    });
    await act(async () =>
      root.render(
        <>
          <Target id="target" />
          <Target id="unknown" />
        </>,
      ),
    );
    vi.mocked(listCanvases).mockRejectedValueOnce(new Error('Offline'));
    await act(async () => {
      await useWorkspaceStore.getState().refreshSpaceTitles();
    });
    expect(targets.get('target')).toMatchObject({
      status: 'ready',
      error: 'Offline',
    });
    expect(targets.get('unknown')).toMatchObject({
      status: 'error',
      error: 'Offline',
    });
  });

  it('shares one list request and distinguishes untitled ready Spaces from missing targets', async () => {
    vi.mocked(listCanvases).mockResolvedValueOnce({
      canvases: [
        {
          canvasId: 'untitled',
          title: null,
          nodeCount: 0,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          canvasId: 'blank',
          title: '  ',
          nodeCount: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    await act(async () => {
      root.render(
        <>
          <Target id="untitled" />
          <Target id="blank" />
          <Target id="missing" />
          <Target id="toString" />
        </>,
      );
    });
    expect(listCanvases).toHaveBeenCalledTimes(1);
    for (const id of ['untitled', 'blank']) {
      expect(targets.get(id)).toMatchObject({
        title: 'spacePreview.untitledSpace',
        status: 'ready',
        error: null,
        nodeCount: 0,
        updatedAt: 1,
      });
    }
    expect(targets.get('missing')?.status).toBe('missing');
    expect(targets.get('toString')?.status).toBe('missing');
  });

  it('reports a fetch error rather than missing and retries without remounting', async () => {
    vi.mocked(listCanvases).mockRejectedValueOnce(
      new Error('Network unavailable'),
    );
    await act(async () => root.render(<Target id="target" />));
    expect(targets.get('target')).toMatchObject({
      status: 'error',
      error: 'Network unavailable',
    });
    vi.mocked(listCanvases).mockResolvedValueOnce({ canvases: [] });
    await act(async () => targets.get('target')?.retry());
    expect(targets.get('target')).toMatchObject({
      status: 'missing',
      error: null,
    });
    expect(listCanvases).toHaveBeenCalledTimes(2);
  });

  it('renders shared title updates without starting another request', async () => {
    useWorkspaceStore.setState({
      spaceTitles: { target: 'Before' },
      spaceTitlesStatus: 'ready',
    });
    await act(async () => root.render(<Target id="target" />));
    act(() => useWorkspaceStore.getState().setSpaceTitle('target', 'Renamed'));
    expect(targets.get('target')).toMatchObject({
      title: 'Renamed',
      status: 'ready',
    });
    expect(listCanvases).not.toHaveBeenCalled();
  });

  it('waits while the workspace is switching instead of calling a target missing', async () => {
    useWorkspaceStore.setState({
      isSyncing: true,
      spaceTitles: { target: 'Previous workspace' },
      spaceSummaries: { target: { nodeCount: 24, updatedAt: 1234 } },
    });
    await act(async () => root.render(<Target id="target" />));
    expect(targets.get('target')?.status).toBe('loading');
    expect(targets.get('target')?.nodeCount).toBeUndefined();
    expect(listCanvases).not.toHaveBeenCalled();
    vi.mocked(listCanvases).mockResolvedValueOnce({ canvases: [] });
    await act(async () => useWorkspaceStore.setState({ isSyncing: false }));
    expect(targets.get('target')?.status).toBe('missing');
    expect(listCanvases).toHaveBeenCalledTimes(1);
  });
});
