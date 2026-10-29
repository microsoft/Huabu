// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CanvasPage from './CanvasPage';
import useCanvasStore from '../../store/canvasStore';
import { usePanelStore } from '../../store/panelStore';
import { createEmptyWorkspace } from '../../store/previewWorkspace/model';
import { usePreviewWorkspaceStore } from '../../store/previewWorkspace/store';

import type * as PreviewActions from '../../store/previewWorkspace/actions';
import type { CanvasSummary } from '@huabu/shared';
import type { Node } from '@xyflow/react';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  revealNodesOnCanvas: vi.fn(),
  fitNodesOnCanvas: vi.fn(),
  openPreviewNode: vi.fn<typeof PreviewActions.openPreviewNode>(() => 'tab-1'),
  toast: vi.fn(),
  requestChatOpen: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  dismissMoveSuccessToasts: vi.fn(),
  workspaceId: undefined as string | undefined,
  refreshSpaceTitles: vi.fn(async () => undefined),
  worldCanvasId: null as string | null,
  spaceSummaries: {} as Record<string, Pick<CanvasSummary, 'parentSpaceId'>>,
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../components/Common/Loading', () => ({
  Loading: () => <div>loading</div>,
}));
vi.mock('../../components/Common/Toast', () => ({ toast: mocks.toast }));
vi.mock('../../components/Space/moveNodesToSpace', () => ({
  dismissMoveSuccessToasts: mocks.dismissMoveSuccessToasts,
  moveNodesToSpace: vi.fn(),
}));
vi.mock('../../components/Nodes/previews', () => ({
  hasNodePreview: (type: string) => type === 'note',
}));
vi.mock('@/utils/canvasViewport', () => ({
  revealNodesOnCanvas: mocks.revealNodesOnCanvas,
  fitNodesOnCanvas: mocks.fitNodesOnCanvas,
}));
vi.mock('../../components/Panels/CanvasLayerPanel', () => ({
  CanvasLayerPanel: () => null,
}));
vi.mock('../../components/Panels/Header/CanvasHeader.tsx', () => ({
  CanvasHeader: () => null,
}));
vi.mock(
  '../../components/Panels/PreviewWorkspace/PreviewWorkspacePanel',
  () => ({ PreviewWorkspacePanel: () => null }),
);
vi.mock('./CenterArea.tsx', () => ({ CenterArea: () => null }));
vi.mock('./MainLayout.tsx', () => ({
  MainLayout: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../../hooks/useGlobalSearchHotkey', () => ({
  useGlobalSearchHotkey: () => undefined,
}));
vi.mock('../../store/canvasAttentionStore', () => ({
  useTrackCanvasAttention: () => undefined,
}));
vi.mock('../../store/canvasSyncStore', () => ({
  useCanvasSyncStore: (
    selector: (state: {
      connect: typeof mocks.connect;
      disconnect: typeof mocks.disconnect;
    }) => unknown,
  ) => selector({ connect: mocks.connect, disconnect: mocks.disconnect }),
}));
vi.mock('../../store/previewWorkspace/actions', () => ({
  openPreviewNode: mocks.openPreviewNode,
}));
vi.mock('../../store/shortcutsUiStore', () => ({
  useShortcutsUiStore: (
    selector: (state: { isOpen: boolean; open: () => void }) => unknown,
  ) => selector({ isOpen: false, open: vi.fn() }),
}));
vi.mock('../../store/toolStore', () => ({
  useToolStore: (
    selector: (state: { setPendingNodeType: () => void }) => unknown,
  ) => selector({ setPendingNodeType: vi.fn() }),
}));
vi.mock('../../store/workspaceStore', () => ({
  useWorkspaceStore: (
    selector: (state: {
      workspaceId: string | undefined;
      worldCanvasId: string | null;
      spaceSummaries: typeof mocks.spaceSummaries;
      refreshSpaceTitles: () => Promise<void>;
    }) => unknown,
  ) =>
    selector({
      workspaceId: mocks.workspaceId,
      worldCanvasId: mocks.worldCanvasId,
      spaceSummaries: mocks.spaceSummaries,
      refreshSpaceTitles: mocks.refreshSpaceTitles,
    }),
}));

const CANVAS_ID = 'canvas-1';
let container: HTMLDivElement;
let root: Root;

function node(type: string, data: Record<string, unknown> = {}): Node {
  return {
    id: 'node-1',
    type,
    position: { x: 0, y: 0 },
    data,
  };
}

async function renderAt(
  path: string,
  canvasNode: Node,
  rfInstance: object | null = {},
  state: unknown = null,
) {
  const selectNodes = vi.fn();
  const loadCanvas = vi.fn(async () => undefined);
  useCanvasStore.setState({
    canvasId: CANVAS_ID,
    canvasNotFound: false,
    isLoading: false,
    nodes: [canvasNode],
    rfInstance: rfInstance as never,
    canvasWrapper: document.createElement('div'),
    selectNodes,
    loadCanvas,
    switchCanvas: vi.fn(async () => undefined),
  });
  usePreviewWorkspaceStore.setState({
    canvasId: CANVAS_ID,
    workspace: createEmptyWorkspace('group-1'),
    readIntentByTab: {},
    requestChatOpen: mocks.requestChatOpen,
  });

  const router = createMemoryRouter(
    [
      { path: '/canvas/:canvasId', element: <CanvasPage /> },
      { path: '/spaces', element: <div>Home</div> },
    ],
    {
      initialEntries: [
        {
          pathname: path.split('?')[0],
          search: path.includes('?') ? `?${path.split('?')[1]}` : '',
          state,
        },
      ],
    },
  );
  await act(async () => root.render(<RouterProvider router={router} />));
  return { router, selectNodes };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.revealNodesOnCanvas.mockClear();
  mocks.fitNodesOnCanvas.mockClear();
  mocks.openPreviewNode.mockReset();
  mocks.toast.mockClear();
  mocks.requestChatOpen.mockClear();
  mocks.refreshSpaceTitles.mockClear();
  mocks.worldCanvasId = null;
  mocks.spaceSummaries = {};
  mocks.workspaceId = undefined;
  mocks.dismissMoveSuccessToasts.mockClear();
  usePanelStore.setState({ isPreviewFullscreen: false });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useCanvasStore.setState({
    canvasId: '',
    nodes: [],
    edges: [],
    rfInstance: null,
    canvasWrapper: null,
    isLoading: false,
  });
  usePreviewWorkspaceStore.setState({
    canvasId: '',
    workspace: createEmptyWorkspace(),
    readIntentByTab: {},
  });
});

describe('CanvasPage node deep-link navigation', () => {
  it.each(['/spaces', '/canvas/other'])(
    'dismisses move feedback when navigating to %s despite the stale canvas store',
    async (destination) => {
      const { router } = await renderAt(`/canvas/${CANVAS_ID}`, node('note'));
      mocks.dismissMoveSuccessToasts.mockClear();
      await act(async () => {
        await router.navigate(destination);
      });
      expect(mocks.dismissMoveSuccessToasts).toHaveBeenCalledOnce();
      expect(useCanvasStore.getState().canvasId).toBe(CANVAS_ID);
    },
  );

  it('keeps move feedback through fullscreen and clears it on Workspace change', async () => {
    const { router } = await renderAt(`/canvas/${CANVAS_ID}`, node('note'));
    mocks.dismissMoveSuccessToasts.mockClear();
    act(() => usePanelStore.setState({ isPreviewFullscreen: true }));
    expect(mocks.dismissMoveSuccessToasts).not.toHaveBeenCalled();
    mocks.workspaceId = 'other-workspace';
    await act(async () => {
      await router.navigate(`/canvas/${CANVAS_ID}?refresh=1`);
    });
    expect(mocks.dismissMoveSuccessToasts).toHaveBeenCalledOnce();
  });

  it('cleans loaded World selections when metadata was ready before the nodes', async () => {
    mocks.worldCanvasId = CANVAS_ID;
    mocks.spaceSummaries = { child: { parentSpaceId: 'parent' } };
    await renderAt(`/canvas/${CANVAS_ID}`, node('note'), null);
    await act(async () => {
      useCanvasStore.getState()._setStateNoAutosave({ isLoading: true });
    });
    const entry = {
      ...node('spacePreview', { targetCanvasId: 'child' }),
      selected: true,
    };
    await act(async () => {
      useCanvasStore.getState()._setStateNoAutosave({
        nodes: [entry],
        edges: [
          { id: 'edge-1', source: entry.id, target: entry.id, selected: true },
        ],
        isLoading: false,
      });
    });
    expect(useCanvasStore.getState().nodes[0].selected).toBe(false);
    expect(useCanvasStore.getState().edges[0].selected).toBe(false);
  });
  it('clears hidden World selections in fullscreen Preview without changing geometry or saving', async () => {
    mocks.worldCanvasId = CANVAS_ID;
    mocks.spaceSummaries = { child: { parentSpaceId: null } };
    const entry = {
      ...node('spacePreview', { targetCanvasId: 'child' }),
      selected: true,
    };
    const { router } = await renderAt(`/canvas/${CANVAS_ID}`, entry, null);
    await act(async () => {
      usePanelStore.setState({ isPreviewFullscreen: true });
      useCanvasStore.getState()._setStateNoAutosave({
        edges: [
          { id: 'edge-1', source: 'node-1', target: 'node-1', selected: true },
        ],
      });
    });
    const before = useCanvasStore.getState();
    mocks.spaceSummaries = { child: { parentSpaceId: 'parent' } };
    await act(async () => {
      await router.navigate(`/canvas/${CANVAS_ID}`);
    });
    const after = useCanvasStore.getState();
    expect(after.nodes[0]).toEqual({ ...entry, selected: false });
    expect(after.edges[0]).toEqual({ ...before.edges[0], selected: false });
    expect(after.pendingSave).toBe(before.pendingSave);
    expect(after.version).toBe(before.version);
    expect(mocks.fitNodesOnCanvas).not.toHaveBeenCalled();
  });
  it('waits for the destination, focuses moved IDs once, and preserves return history', async () => {
    const { router, selectNodes } = await renderAt(
      `/canvas/${CANVAS_ID}`,
      node('note'),
      null,
      {
        focusNodeIds: ['node-1'],
        returnToSpace: 'source',
        workspaceId: undefined,
      },
    );
    expect(selectNodes).not.toHaveBeenCalled();
    const wrapper = useCanvasStore.getState().canvasWrapper;
    if (!wrapper) throw new Error('Missing Canvas wrapper');
    const focus = vi.spyOn(wrapper, 'focus');
    await act(async () => {
      useCanvasStore.setState({ rfInstance: {} as never });
    });
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(selectNodes).toHaveBeenCalledWith(['node-1'], false);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(mocks.fitNodesOnCanvas).toHaveBeenCalledWith(
      useCanvasStore.getState().rfInstance,
      ['node-1'],
      0.15,
      1,
    );
    expect(mocks.openPreviewNode).not.toHaveBeenCalled();
    expect(router.state.location.state).toEqual({
      returnToSpace: 'source',
      workspaceId: undefined,
    });
    await act(async () => useCanvasStore.setState({ version: 23 }));
    expect(mocks.fitNodesOnCanvas).toHaveBeenCalledOnce();
  });
  it('refreshes shared Space metadata on ordinary canvas entry, focus, and workspace changes', async () => {
    await renderAt(`/canvas/${CANVAS_ID}`, node('note'));
    expect(mocks.refreshSpaceTitles).toHaveBeenCalledTimes(1);
    act(() => window.dispatchEvent(new Event('focus')));
    expect(mocks.refreshSpaceTitles).toHaveBeenCalledTimes(2);
    act(() => window.dispatchEvent(new Event('workspace-changed')));
    expect(mocks.refreshSpaceTitles).toHaveBeenCalledTimes(3);
    await act(async () => root.render(null));
    act(() => window.dispatchEvent(new Event('focus')));
    expect(mocks.refreshSpaceTitles).toHaveBeenCalledTimes(3);
  });

  it('consumes destination focus in fullscreen without selecting, fitting, or replaying it on exit', async () => {
    usePanelStore.setState({ isPreviewFullscreen: true });
    const { router, selectNodes } = await renderAt(
      `/canvas/${CANVAS_ID}`,
      node('note'),
      null,
      {
        focusNodeIds: ['node-1'],
        returnToSpace: 'source',
        workspaceId: undefined,
      },
    );
    expect(usePanelStore.getState().isPreviewFullscreen).toBe(true);
    expect(router.state.location.state).toEqual({
      returnToSpace: 'source',
      workspaceId: undefined,
    });
    expect(useCanvasStore.getState().nodes[0].id).toBe('node-1');
    expect(selectNodes).not.toHaveBeenCalled();
    await act(async () => {
      usePanelStore.setState({ isPreviewFullscreen: false });
      useCanvasStore.setState({ rfInstance: {} as never });
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(selectNodes).not.toHaveBeenCalled();
    expect(mocks.fitNodesOnCanvas).not.toHaveBeenCalled();
  });

  it('selects, focuses, and permanently opens a hydrated preview once', async () => {
    const { selectNodes } = await renderAt(
      `/canvas/${CANVAS_ID}?node=node-1`,
      node('note'),
    );

    expect(selectNodes).toHaveBeenCalledWith(['node-1'], false);
    expect(mocks.openPreviewNode).toHaveBeenCalledWith('node-1', {
      transient: false,
      markReadIntent: false,
    });
    expect(mocks.revealNodesOnCanvas).toHaveBeenCalledWith(
      useCanvasStore.getState().rfInstance,
      useCanvasStore.getState().canvasWrapper,
      ['node-1'],
      400,
    );

    act(() => useCanvasStore.setState({ version: 2 }));
    expect(mocks.revealNodesOnCanvas).toHaveBeenCalledOnce();
  });

  it('waits for React Flow hydration before consuming the target', async () => {
    const { selectNodes } = await renderAt(
      `/canvas/${CANVAS_ID}?node=node-1`,
      node('note'),
      null,
    );
    expect(selectNodes).not.toHaveBeenCalled();

    act(() => useCanvasStore.setState({ rfInstance: {} as never }));

    expect(selectNodes).toHaveBeenCalledWith(['node-1'], false);
    expect(mocks.revealNodesOnCanvas).toHaveBeenCalledOnce();
  });

  it('reconsumes the retained target after browser back navigation', async () => {
    const { router } = await renderAt(
      `/canvas/${CANVAS_ID}?node=node-1`,
      node('note'),
    );
    expect(mocks.revealNodesOnCanvas).toHaveBeenCalledOnce();

    await act(async () => router.navigate(`/canvas/${CANVAS_ID}`));
    await act(async () => router.navigate(-1));

    expect(router.state.location.search).toBe('?node=node-1');
    expect(mocks.revealNodesOnCanvas).toHaveBeenCalledTimes(2);
  });

  it('opens an existing Agent thread without requesting composer focus', async () => {
    await renderAt(
      `/canvas/${CANVAS_ID}?node=node-1`,
      node('question', { threadId: 'thread-1' }),
    );

    expect(mocks.openPreviewNode).toHaveBeenCalledWith('node-1', {
      transient: false,
      markReadIntent: false,
    });
    expect(mocks.requestChatOpen).toHaveBeenCalledWith('tab-1', 'bottom');
    expect(usePanelStore.getState().focusChatInputRequest).toBeNull();
  });

  it('does not infer reading from deep-link entry, history navigation, or reload', async () => {
    const actual = await vi.importActual<typeof PreviewActions>(
      '../../store/previewWorkspace/actions',
    );
    mocks.openPreviewNode.mockImplementation(actual.openPreviewNode);
    const url = `/canvas/${CANVAS_ID}?node=node-1`;
    const question = node('question', {
      threadId: 'thread-1',
      status: 'done',
      viewed: false,
    });
    const { router } = await renderAt(url, question);
    const preview = usePreviewWorkspaceStore.getState();
    const tabId = preview.workspace.groups[0].activeTabId;
    expect(tabId).toBeTruthy();
    expect(preview.readIntentByTab).toEqual({});
    await act(async () => router.navigate(`/canvas/${CANVAS_ID}`));
    await act(async () => router.navigate(-1));
    expect(usePreviewWorkspaceStore.getState().readIntentByTab).toEqual({});
    expect(
      Object.keys(usePreviewWorkspaceStore.getState().workspace.tabs),
    ).toEqual([tabId]);

    await act(async () => root.render(null));
    await renderAt(url, question);
    const restored = usePreviewWorkspaceStore.getState();
    expect(restored.readIntentByTab).toEqual({});
    const restoredTabId = restored.workspace.groups[0].activeTabId;
    if (!restoredTabId) throw new Error('Missing restored Question tab');
    act(() => restored.activateTab(restoredTabId));
    expect(
      usePreviewWorkspaceStore.getState().readIntentByTab[restoredTabId],
    ).toBeTruthy();
  });

  it('does not create or open a conversation for an idle Question', async () => {
    const { selectNodes } = await renderAt(
      `/canvas/${CANVAS_ID}?node=node-1`,
      node('question'),
    );

    expect(selectNodes).toHaveBeenCalledWith(['node-1'], false);
    expect(mocks.revealNodesOnCanvas).toHaveBeenCalledOnce();
    expect(mocks.openPreviewNode).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(
      'canvasPage.nodeFocusedNoPreview',
      { tone: 'info' },
    );
  });

  it.each(['?node=bad', '?node=node-missing'])(
    'loads the Space and gives one metadata-safe fallback for %s',
    async (search) => {
      await renderAt(`/canvas/${CANVAS_ID}${search}`, node('note'));

      expect(mocks.openPreviewNode).not.toHaveBeenCalled();
      expect(mocks.revealNodesOnCanvas).not.toHaveBeenCalled();
      expect(mocks.toast).toHaveBeenCalledWith(
        'canvasPage.nodeTargetUnavailable',
        { tone: 'warning' },
      );
    },
  );
});
