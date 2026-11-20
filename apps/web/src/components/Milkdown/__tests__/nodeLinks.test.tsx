// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { MilkdownMessageCard } from '@/components/Messages/AIMessage/MilkdownMessageCard';
import { MilkdownPreview } from '@/components/Milkdown/MilkdownPreview';
import { isElectron } from '@/hooks/useElectron';
import useCanvasStore from '@/store/canvasStore';
import { usePanelStore } from '@/store/panelStore';
import { createEmptyWorkspace } from '@/store/previewWorkspace/model';
import { usePreviewWorkspaceStore } from '@/store/previewWorkspace/store';
import { registerAppNavigate } from '@/utils/appNavigation';
import { isMac } from '@/utils/platform';

vi.mock('@/hooks/useElectron', () => ({ isElectron: vi.fn() }));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const canvasId = 'node-links-canvas';
let root: Root | undefined;
let container: HTMLDivElement | undefined;

const tabTargets = () =>
  Object.values(usePreviewWorkspaceStore.getState().workspace.tabs).map(
    (tab) => tab.target,
  );

const selectedNodeIds = () =>
  useCanvasStore
    .getState()
    .nodes.filter((node) => node.selected)
    .map((node) => node.id);

const click = (link: Element, init: MouseEventInit = {}) => {
  const event = new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    button: 0,
    detail: 1,
    ...init,
  });
  act(() => link.dispatchEvent(event));
  return event;
};

async function renderLinks(node: React.ReactNode, count: number) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
  await act(async () => {
    await vi.waitFor(() =>
      expect(container?.querySelectorAll('.ProseMirror a')).toHaveLength(count),
    );
  });
  return [...(container?.querySelectorAll('.ProseMirror a') ?? [])];
}

beforeEach(() => {
  vi.mocked(isElectron).mockReturnValue(false);
  vi.spyOn(window, 'open').mockReturnValue(null);
  useCanvasStore.setState({
    canvasId,
    nodes: [
      {
        id: 'node-question',
        type: 'question',
        position: { x: 0, y: 0 },
        data: { label: 'Conversation', threadId: 'thread-linked' },
      },
    ] as unknown as ReturnType<typeof useCanvasStore.getState>['nodes'],
  });
  usePreviewWorkspaceStore.setState({
    canvasId,
    workspace: createEmptyWorkspace('group'),
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
  registerAppNavigate(null);
  usePanelStore.setState({ isPreviewFullscreen: false });
  useCanvasStore.setState({ canvasId: '', nodes: [] });
  usePreviewWorkspaceStore.setState({
    canvasId: '',
    workspace: createEmptyWorkspace('group'),
  });
});

it('locates the linked node from a Chat message without opening a tab', async () => {
  const [link, missing] = await renderLinks(
    <MilkdownMessageCard
      content="[Conversation](#node-question) and [gone](#node-missing)"
      threadId="thread-source"
    />,
    2,
  );

  const event = click(link);

  expect(event.defaultPrevented).toBe(true);
  expect(window.open).not.toHaveBeenCalled();
  expect(tabTargets()).toEqual([]);
  expect(selectedNodeIds()).toEqual(['node-question']);
  // A follow modifier keeps the link in-app; a deleted target opens nothing.
  click(link, isMac ? { metaKey: true } : { ctrlKey: true });
  click(missing);
  expect(window.open).not.toHaveBeenCalled();
  expect(tabTargets()).toEqual([]);
});

it('leaves a node link inert without a host and still blocks unsafe hrefs', async () => {
  const [nodeLink, unsafe] = await renderLinks(
    <MilkdownPreview markdown="[node](#node-question) [bad](#not-a-node)" />,
    2,
  );

  expect(click(nodeLink).defaultPrevented).toBe(true);
  expect(click(unsafe).defaultPrevented).toBe(true);
  expect(window.open).not.toHaveBeenCalled();
  expect(tabTargets()).toEqual([]);
});

it('enters the owning Space for a node link in a conversation presented from another Space', async () => {
  const navigate = vi.fn();
  registerAppNavigate(navigate);
  const [link] = await renderLinks(
    <MilkdownMessageCard
      content="[Research note](#node-remote)"
      threadId="thread-source"
      sourceCanvasId="owner/canvas"
    />,
    1,
  );

  click(link);

  expect(navigate).toHaveBeenCalledExactlyOnceWith(
    '/canvas/owner%2Fcanvas?node=node-remote',
    {
      state: expect.objectContaining({
        locateNodeOnly: true,
        returnToSpace: canvasId,
      }),
    },
  );
  expect(window.open).not.toHaveBeenCalled();
  expect(tabTargets()).toEqual([]);
});

it('accepts a link whose author doubled the node- prefix', async () => {
  const [link] = await renderLinks(
    <MilkdownMessageCard
      content="[Conversation](#node-node-question)"
      threadId="thread-source"
    />,
    1,
  );

  click(link);

  expect(selectedNodeIds()).toEqual(['node-question']);
});

it('keeps the caret out of a node chip without affecting ordinary links', async () => {
  const [nodeLink, webLink] = await renderLinks(
    <MilkdownMessageCard
      content="[Conversation](#node-question) [docs](https://example.com)"
      threadId="thread-source"
    />,
    2,
  );
  const press = (link: Element) => {
    const event = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    act(() => link.dispatchEvent(event));
    return event.defaultPrevented;
  };

  expect(press(nodeLink)).toBe(true);
  expect(press(webLink)).toBe(false);
});

it('keeps a deep link to this Space in-app for plain and modifier clicks', async () => {
  const [link] = await renderLinks(
    <MilkdownMessageCard
      content={`[Conversation](/canvas/${canvasId}?node=node-question)`}
      threadId="thread-source"
    />,
    1,
  );

  click(link);
  expect(selectedNodeIds()).toEqual(['node-question']);

  act(() => useCanvasStore.getState().selectNodes([], false));
  click(link, isMac ? { metaKey: true } : { ctrlKey: true });
  expect(selectedNodeIds()).toEqual(['node-question']);
  expect(window.open).not.toHaveBeenCalled();
});

it('stays in fullscreen and queues the reveal when the Canvas is unmounted', async () => {
  usePanelStore.setState({ isPreviewFullscreen: true });
  useCanvasStore.setState({ rfInstance: null, canvasWrapper: null });
  const [link] = await renderLinks(
    <MilkdownMessageCard
      content="[Conversation](#node-question)"
      threadId="thread-source"
    />,
    1,
  );

  click(link);

  expect(usePanelStore.getState().isPreviewFullscreen).toBe(true);
  expect(selectedNodeIds()).toEqual(['node-question']);
  expect(useCanvasStore.getState().pendingRevealNodeIds).toEqual([
    'node-question',
  ]);
  expect(tabTargets()).toEqual([]);
});
