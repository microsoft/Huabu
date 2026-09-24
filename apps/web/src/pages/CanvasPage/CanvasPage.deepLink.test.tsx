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

import type { Node } from '@xyflow/react';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  revealNodesOnCanvas: vi.fn(),
  openPreviewNode: vi.fn(() => 'tab-1'),
  toast: vi.fn(),
  requestChatOpen: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  refreshSpaceTitles: vi.fn(async () => undefined),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../components/Common/Loading', () => ({
  Loading: () => <div>loading</div>,
}));
vi.mock('../../components/Common/Toast', () => ({ toast: mocks.toast }));
vi.mock('../../components/Nodes/previews', () => ({
  hasNodePreview: (type: string) => type === 'note',
}));
vi.mock('../../components/Panels/CanvasLayerPanel/focusNodesOnCanvas', () => ({
  revealNodesOnCanvas: mocks.revealNodesOnCanvas,
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
      worldCanvasId: null;
      refreshSpaceTitles: () => Promise<void>;
    }) => unknown,
  ) =>
    selector({
      worldCanvasId: null,
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
  });
  usePreviewWorkspaceStore.setState({
    canvasId: CANVAS_ID,
    workspace: createEmptyWorkspace('group-1'),
    requestChatOpen: mocks.requestChatOpen,
  });

  const router = createMemoryRouter(
    [{ path: '/canvas/:canvasId', element: <CanvasPage /> }],
    { initialEntries: [path] },
  );
  await act(async () => root.render(<RouterProvider router={router} />));
  return { router, selectNodes };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.revealNodesOnCanvas.mockClear();
  mocks.openPreviewNode.mockClear();
  mocks.toast.mockClear();
  mocks.requestChatOpen.mockClear();
  mocks.refreshSpaceTitles.mockClear();
  usePanelStore.setState({ isPreviewFullscreen: false });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useCanvasStore.setState({
    canvasId: '',
    nodes: [],
    rfInstance: null,
    canvasWrapper: null,
    isLoading: false,
  });
  usePreviewWorkspaceStore.setState({
    canvasId: '',
    workspace: createEmptyWorkspace(),
  });
});

describe('CanvasPage node deep-link navigation', () => {
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

  it('selects, focuses, and permanently opens a hydrated preview once', async () => {
    const { selectNodes } = await renderAt(
      `/canvas/${CANVAS_ID}?node=node-1`,
      node('note'),
    );

    expect(selectNodes).toHaveBeenCalledWith(['node-1'], false);
    expect(mocks.openPreviewNode).toHaveBeenCalledWith('node-1', {
      transient: false,
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
    });
    expect(mocks.requestChatOpen).toHaveBeenCalledWith('tab-1', 'bottom');
    expect(usePanelStore.getState().focusChatInputRequest).toBeNull();
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
