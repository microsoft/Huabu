// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Behavioural tests for the tabbed preview surface.
 *
 * The topology reducers are covered in `store/previewWorkspace/model.test.ts`;
 * these assert what the UI adds — which tab is mounted, what the tab strip
 * exposes to assistive technology, and that keyboard navigation follows the
 * ARIA tabs pattern.
 */

import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  rememberMessageListScrollPosition,
  restoreMessageListScrollPosition,
} from '@/components/Messages/messageListScroll';
import useCanvasStore from '@/store/canvasStore';
import { useChatStore } from '@/store/chatStore';
import { createEmptyWorkspace } from '@/store/previewWorkspace/model';
import { messageListViewKey } from '@/store/previewWorkspace/scrollMemory';
import { usePreviewWorkspaceStore } from '@/store/previewWorkspace/store';

import { PreviewTabDragOverlay } from './PreviewTab';
import {
  PreviewTabDragOverlayPortal,
  PreviewWorkspace,
  settleActivePreviewTab,
  subscribeToTabDragInterruption,
} from './PreviewWorkspace';
import { PreviewWorkspacePanel } from './PreviewWorkspacePanel';
import {
  groupDropId,
  resolveTabDropDestination,
  resolveTabDropIndicator,
} from './tabDnd';

import type { Node } from '@xyflow/react';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.hoisted(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => values.set(k, v),
      removeItem: (k: string) => values.delete(k),
      clear: () => values.clear(),
      key: (i: number) => [...values.keys()][i] ?? null,
      get length() {
        return values.size;
      },
    },
  });
});

// The Chat panel pulls in the whole agent stack; the workspace only needs to
// know it dispatched to it.
vi.mock('../ChatPanel', () => ({
  ChatPanel: ({
    session,
    onCommit,
    adjacentNodeSourceId,
  }: {
    session?: { threadId: string };
    onCommit?: () => void;
    adjacentNodeSourceId?: string;
  }) => (
    <div
      data-testid="chat-panel"
      data-thread-id={session?.threadId}
      data-adjacent-node-source-id={adjacentNodeSourceId}
    >
      <button type="button" data-testid="commit-chat" onClick={onCommit} />
    </div>
  ),
}));

vi.mock('../../Nodes/NodePreviewContent', () => ({
  NodePreviewContent: ({
    id,
    focusRequestNonce,
  }: {
    id?: string;
    focusRequestNonce?: number;
  }) => (
    <div
      data-preview-node-id={id}
      data-focus-request-nonce={focusRequestNonce}
    />
  ),
}));

const CANVAS_ID = 'canvas-1';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function canvasNode(id: string, label: string, type = 'note'): Node {
  return { id, type, position: { x: 0, y: 0 }, data: { label } };
}

const store = () => usePreviewWorkspaceStore.getState();

function openNode(nodeId: string, transient = false) {
  return store().openPreviewTarget(
    { kind: 'node', canvasId: CANVAS_ID, nodeId },
    { transient },
  );
}

function render(nodes: Node[]) {
  useCanvasStore.setState({ nodes, canvasId: CANVAS_ID });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<PreviewWorkspace />));
}

async function flushActivityWork() {
  await act(async () => {});
}

const tabs = () =>
  Array.from(container?.querySelectorAll('[role="tab"]') ?? []);
const activeTabName = () =>
  container
    ?.querySelector('[role="tab"][aria-selected="true"]')
    ?.getAttribute('aria-label');
const mountedNodeId = () =>
  container
    ?.querySelector('[data-preview-active="true"] [data-preview-node-id]')
    ?.getAttribute('data-preview-node-id');

beforeEach(() => {
  usePreviewWorkspaceStore.setState({
    canvasId: CANVAS_ID,
    workspace: createEmptyWorkspace('g1'),
    nodeFocusRequest: null,
    nodeFocusRequestSeq: 0,
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  useCanvasStore.setState({ nodes: [], canvasId: '', worldReferences: {} });
});

describe('tab strip', () => {
  it('forgets a Chat scroll position when its tab is explicitly closed', () => {
    const threadId = 'thread-close-scroll';
    const viewKey = messageListViewKey(CANVAS_ID, threadId);
    store().openPreviewTarget({ kind: 'chat', canvasId: CANVAS_ID, threadId });
    rememberMessageListScrollPosition(viewKey, 420);
    render([]);

    const closeButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label^="Close "]',
    );
    expect(closeButton).not.toBeNull();
    act(() => closeButton?.click());

    const messageList = document.createElement('div');
    expect(restoreMessageListScrollPosition(messageList, viewKey)).toBe(false);
  });

  it('cancels a tab pointer sensor when its document is deactivated', () => {
    const cancel = vi.fn();
    const unsubscribe = subscribeToTabDragInterruption(cancel);

    window.dispatchEvent(new Event('blur'));
    expect(cancel).toHaveBeenCalledOnce();

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(cancel).toHaveBeenCalledTimes(2);

    unsubscribe();
    window.dispatchEvent(new Event('blur'));
    expect(cancel).toHaveBeenCalledTimes(2);

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
  });

  it('renders a labelled tab ghost while dragging', () => {
    openNode('a');
    const tab = Object.values(store().workspace.tabs)[0];
    useCanvasStore.setState({
      nodes: [canvasNode('a', 'Alpha')],
      canvasId: CANVAS_ID,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<PreviewTabDragOverlay tab={tab} />));

    const overlay = container.querySelector(
      '[data-testid="preview-tab-drag-overlay"]',
    );
    expect(overlay?.textContent).toContain('Alpha');
    expect(overlay?.classList.contains('shadow-md')).toBe(true);
  });

  it('hosts the drag overlay portal outside Preview layout transforms', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => root?.render(<PreviewTabDragOverlayPortal tab={undefined} />));

    const portal = document.querySelector(
      '[data-testid="preview-tab-drag-portal"]',
    );
    expect(portal).not.toBeNull();
    expect(container.contains(portal)).toBe(false);
    expect(portal?.parentElement).toBe(document.body);
  });

  it('renders an unbound Chat session with compact workspace chrome', () => {
    store().openPreviewTarget({
      kind: 'chat',
      canvasId: CANVAS_ID,
      threadId: 'thread-1',
    });
    render([]);

    expect(
      container
        ?.querySelector('[data-testid="chat-panel"]')
        ?.getAttribute('data-thread-id'),
    ).toBe('thread-1');
    expect(tabs()[0].classList.contains('h-9')).toBe(true);
  });

  it('sizes tabs to content without shrinking their controls', () => {
    openNode('a');
    openNode('b');
    render([canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')]);

    const [inactiveTab, activeTab] = tabs();
    expect(inactiveTab.classList.contains('min-w-20')).toBe(true);
    expect(inactiveTab.classList.contains('w-fit')).toBe(true);
    expect(inactiveTab.classList.contains('flex-none')).toBe(true);
    expect(inactiveTab.classList.contains('flex-[0_1_auto]')).toBe(false);
    for (const tab of [inactiveTab, activeTab]) {
      const actionRail = tab.querySelector<HTMLElement>(
        '[data-testid="preview-tab-actions"]',
      );
      expect(actionRail?.classList.contains('shrink-0')).toBe(true);
      expect(actionRail?.classList.contains('absolute')).toBe(false);
      expect(actionRail?.classList.contains('opacity-0')).toBe(false);
      expect(actionRail?.classList.contains('pointer-events-none')).toBe(false);
      expect(
        actionRail?.querySelector('[aria-label^="Close "]'),
      ).not.toBeNull();
    }
    expect(activeTab.classList.contains('border-r')).toBe(true);
    expect(activeTab.classList.contains('last:border-r-0')).toBe(false);
    expect(activeTab.classList.contains('bg-surface')).toBe(true);
    expect(activeTab.classList.contains('after:bg-info-light')).toBe(true);
    expect(activeTab.classList.contains('after:top-0')).toBe(true);
    expect(activeTab.classList.contains('after:bottom-0')).toBe(false);
    expect(activeTab.classList.contains('before:bg-surface')).toBe(false);
    expect(activeTab.classList.contains('bg-bg-default')).toBe(false);
    expect(activeTab.parentElement?.classList.contains('overflow-x-auto')).toBe(
      true,
    );
    expect(
      activeTab.parentElement?.classList.contains('overflow-y-hidden'),
    ).toBe(true);
  });

  it('renders a Question node through its own Chat session', () => {
    openNode('question-1');
    render([
      {
        ...canvasNode('question-1', 'Why?', 'question'),
        data: { label: 'Why?', threadId: 'thread-question-1' },
      },
    ]);

    expect(
      container
        ?.querySelector('[data-testid="chat-panel"]')
        ?.getAttribute('data-thread-id'),
    ).toBe('thread-question-1');
  });

  it('renders a World Question reference through its source session', () => {
    openNode('question-ref');
    useCanvasStore.setState({
      worldReferences: {
        'question-ref': {
          kind: 'nodeRef',
          referenceNodeId: 'question-ref',
          target: { canvasId: 'source-canvas', nodeId: 'source-question' },
          status: 'ok',
          source: {
            type: 'question',
            threadId: 'source-thread',
            status: 'done',
            viewed: true,
            agentMode: 'ask',
            agentBinding: { kind: 'internal' },
          },
        },
      },
    });
    render([canvasNode('question-ref', 'Pinned question', 'nodeRef')]);

    expect(
      container
        ?.querySelector('[data-testid="chat-panel"]')
        ?.getAttribute('data-thread-id'),
    ).toBe('source-thread');
  });

  it('creates a Chat tab from the workspace toolbar while a node is active', () => {
    openNode('a');
    render([canvasNode('a', 'Alpha')]);

    const newChatButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="New conversation"]',
    );
    expect(newChatButton).not.toBeNull();
    act(() => newChatButton?.click());

    expect(tabs()).toHaveLength(2);
    expect(activeTabName()).toBe('Chat');
    expect(
      Object.values(store().workspace.tabs).some(
        (tab) => tab.target.kind === 'node' && tab.target.nodeId === 'a',
      ),
    ).toBe(true);
  });

  it('keeps the active and most recent eligible tab mounted', async () => {
    openNode('a');
    openNode('b');
    render([canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')]);
    await flushActivityWork();

    expect(tabs()).toHaveLength(2);
    expect(mountedNodeId()).toBe('b');
    expect(container?.querySelectorAll('[data-preview-node-id]')).toHaveLength(
      2,
    );
    expect(
      container?.querySelector<HTMLElement>('[data-preview-active="false"]')
        ?.style.display,
    ).toBe('none');
  });

  it('unmounts the oldest eligible tab when the warm slot advances', async () => {
    const firstTabId = openNode('a');
    openNode('b');
    openNode('c');
    render([
      canvasNode('a', 'Alpha'),
      canvasNode('b', 'Beta'),
      canvasNode('c', 'Gamma'),
    ]);
    await flushActivityWork();

    expect(
      Array.from(
        container?.querySelectorAll('[data-preview-node-id]') ?? [],
      ).map((preview) => preview.getAttribute('data-preview-node-id')),
    ).toEqual(['b', 'c']);

    await act(async () => store().activateTab(firstTabId));

    expect(
      Array.from(
        container?.querySelectorAll('[data-preview-node-id]') ?? [],
      ).map((preview) => preview.getAttribute('data-preview-node-id')),
    ).toEqual(['a', 'c']);
  });

  it('unmounts a warm tab when it is closed', async () => {
    openNode('a');
    openNode('b');
    render([canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')]);
    await flushActivityWork();

    expect(
      container?.querySelector('[data-preview-node-id="a"]'),
    ).not.toBeNull();

    const closeAlpha = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Close Alpha"]',
    );
    expect(closeAlpha).not.toBeNull();
    act(() => closeAlpha?.click());

    expect(container?.querySelector('[data-preview-node-id="a"]')).toBeNull();
  });

  it('unmounts inactive iframe previews instead of warming them', () => {
    openNode('web');
    openNode('note');
    render([
      canvasNode('web', 'Website', 'web'),
      canvasNode('note', 'Note', 'note'),
    ]);

    expect(container?.querySelector('[data-preview-node-id="web"]')).toBeNull();
  });

  it('derives the title from the node, so a rename propagates', () => {
    openNode('a');
    render([canvasNode('a', 'Alpha')]);
    expect(tabs()[0].textContent).toContain('Alpha');

    act(() => {
      useCanvasStore.setState({ nodes: [canvasNode('a', 'Renamed')] });
    });

    expect(tabs()[0].textContent).toContain('Renamed');
  });

  it('falls back to the untitled label for an unnamed node', () => {
    openNode('a');
    render([canvasNode('a', '')]);

    expect(tabs()[0].textContent).toContain('Untitled');
  });

  it('carries the node type in the accessible name', () => {
    openNode('a');
    render([canvasNode('a', 'Alpha', 'pdf')]);

    expect(tabs()[0].getAttribute('aria-label')).toBe('Alpha (pdf)');
  });

  it('wires each tab to its panel', () => {
    openNode('a');
    render([canvasNode('a', 'Alpha')]);

    const panelId = tabs()[0].getAttribute('aria-controls');
    const panel = container?.querySelector('[role="tabpanel"]');
    expect(panel?.id).toBe(panelId);
    expect(panel?.getAttribute('aria-labelledby')).toBe(tabs()[0].id);
  });
});

describe('tab drag feedback', () => {
  const workspaceWithTabs = () => store().workspace;
  const tabIdForNode = (nodeId: string) =>
    Object.values(workspaceWithTabs().tabs).find(
      (tab) => tab.target.kind === 'node' && tab.target.nodeId === nodeId,
    )?.id ?? '';

  it('shows an insertion marker before a hovered tab when moving left', () => {
    openNode('a');
    openNode('b');
    const a = tabIdForNode('a');
    const b = tabIdForNode('b');
    expect(resolveTabDropIndicator(workspaceWithTabs(), b, a)).toEqual({
      type: 'tab',
      tabId: a,
      edge: 'before',
    });
  });

  it('shows an insertion marker after a hovered tab when moving right', () => {
    openNode('a');
    openNode('b');
    const a = tabIdForNode('a');
    const b = tabIdForNode('b');
    expect(resolveTabDropIndicator(workspaceWithTabs(), a, b)).toEqual({
      type: 'tab',
      tabId: b,
      edge: 'after',
    });
  });

  it('shows an append marker when hovering empty strip space', () => {
    openNode('a');
    const a = tabIdForNode('a');
    expect(
      resolveTabDropIndicator(workspaceWithTabs(), a, groupDropId('g1')),
    ).toEqual({ type: 'group-end', groupId: 'g1' });
  });

  it('does not mark the dragged tab as its own destination', () => {
    openNode('a');
    const a = tabIdForNode('a');
    expect(resolveTabDropIndicator(workspaceWithTabs(), a, a)).toBeNull();
  });
});

describe('activation', () => {
  it('settles an active authored node before its renderer is left', () => {
    const first = openNode('a');
    openNode('b');
    store().activateTab(first);
    const workspace = store().workspace;
    const settle = vi.fn();

    settleActivePreviewTab(
      workspace,
      [canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')],
      first,
      settle,
    );

    expect(settle).toHaveBeenCalledWith('a');
  });

  it('does not settle an inactive or read-only preview tab', () => {
    const inactive = openNode('a');
    const active = openNode('b');
    const workspace = store().workspace;
    const settle = vi.fn();

    settleActivePreviewTab(
      workspace,
      [canvasNode('a', 'Alpha'), canvasNode('b', 'Beta', 'pdf')],
      inactive,
      settle,
    );
    settleActivePreviewTab(
      workspace,
      [canvasNode('a', 'Alpha'), canvasNode('b', 'Beta', 'pdf')],
      active,
      settle,
    );

    expect(settle).not.toHaveBeenCalled();
  });

  it('switches the mounted panel on click', async () => {
    openNode('a');
    openNode('b');
    render([canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')]);

    await act(async () =>
      tabs()[0].dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );

    expect(mountedNodeId()).toBe('a');
  });

  it('closes a tab from its close control without touching the others', async () => {
    openNode('a');
    openNode('b');
    render([canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')]);

    const close = tabs()[1].querySelector('button');
    expect(tabs()[1].hasAttribute('title')).toBe(false);
    expect(close?.hasAttribute('title')).toBe(false);
    expect(close?.getAttribute('aria-label')).toContain('Beta');
    await act(async () =>
      close?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );

    expect(tabs()).toHaveLength(1);
    expect(mountedNodeId()).toBe('a');
  });

  it('collapses the host when the final tab closes', () => {
    const onCollapse = vi.fn();
    openNode('a');
    useCanvasStore.setState({
      nodes: [canvasNode('a', 'Alpha')],
      canvasId: CANVAS_ID,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<PreviewWorkspace onCollapse={onCollapse} />));

    const close = tabs()[0].querySelector('button');
    act(() => close?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(onCollapse).toHaveBeenCalledOnce();
  });

  it('promotes a transient tab on double click', () => {
    const tabId = openNode('a', true);
    render([canvasNode('a', 'Alpha')]);
    expect(store().workspace.tabs[tabId].transient).toBe(true);

    act(() =>
      tabs()[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true })),
    );

    expect(store().workspace.tabs[tabId].transient).toBe(false);
  });

  it('promotes a transient tab with its Pin action', () => {
    const tabId = openNode('a', true);
    render([canvasNode('a', 'Alpha')]);

    const keepButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Keep Alpha open"]',
    );
    expect(keepButton).not.toBeNull();
    const closeButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Close Alpha"]',
    );
    const actionRail = container?.querySelector<HTMLElement>(
      '[data-testid="preview-tab-actions"]',
    );
    const title = tabs()[0].querySelector<HTMLElement>(
      '[data-testid="preview-tab-title"]',
    );
    const icon = tabs()[0].querySelector<HTMLElement>(
      '[data-testid="preview-tab-icon"]',
    );
    expect(title?.classList.contains('group-hover:text-fg-subtle')).toBe(true);
    expect(title?.classList.contains('transition-colors')).toBe(true);
    expect(icon?.classList.contains('group-hover:text-fg-subtle')).toBe(true);
    expect(icon?.classList.contains('transition-colors')).toBe(true);
    expect(actionRail?.classList.contains('absolute')).toBe(false);
    expect(actionRail?.classList.contains('shrink-0')).toBe(true);
    expect(actionRail?.classList.contains('opacity-0')).toBe(false);
    expect(actionRail?.classList.contains('pointer-events-none')).toBe(false);
    expect(actionRail?.classList.contains('group-hover:opacity-100')).toBe(
      false,
    );
    expect(actionRail?.contains(keepButton ?? null)).toBe(true);
    expect(actionRail?.contains(closeButton ?? null)).toBe(true);
    expect(keepButton?.classList.contains('shadow-sm')).toBe(false);
    expect(closeButton?.classList.contains('shadow-sm')).toBe(false);
    act(() => keepButton?.click());

    expect(store().workspace.tabs[tabId].transient).toBe(false);
    expect(
      container?.querySelector('[aria-label="Keep Alpha open"]'),
    ).toBeNull();
  });

  it('keeps a transient tab transient when opening it to the side', () => {
    const transientTabId = openNode('a', true);
    openNode('b');
    store().activateTab(transientTabId);
    render([canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')]);

    const openToSideButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Open to the side"]',
    );
    expect(openToSideButton).not.toBeNull();
    act(() => openToSideButton?.click());

    expect(store().workspace.groups).toHaveLength(2);
    expect(store().workspace.tabs[transientTabId].transient).toBe(true);
  });

  it('promotes a transient tab when its renderer commits a mutation', () => {
    const tabId = store().openPreviewTarget(
      { kind: 'chat', canvasId: CANVAS_ID, threadId: 'thread-1' },
      { transient: true },
    );
    render([]);

    expect(store().workspace.tabs[tabId].transient).toBe(true);
    act(() =>
      container
        ?.querySelector<HTMLButtonElement>('[data-testid="commit-chat"]')
        ?.click(),
    );

    expect(store().workspace.tabs[tabId].transient).toBe(false);
  });

  it('describes transient tabs without promoting them during browsing', () => {
    const tabId = openNode('a', true);
    render([canvasNode('a', 'Alpha')]);

    expect(activeTabName()).toContain('Temporary preview');
    expect(store().workspace.tabs[tabId].transient).toBe(true);
  });

  it('reuses the inspection slot while browsing transiently', async () => {
    openNode('a', true);
    openNode('b', true);
    render([canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')]);
    await flushActivityWork();

    expect(tabs()).toHaveLength(1);
    expect(mountedNodeId()).toBe('b');
  });
});

describe('keyboard', () => {
  function arrow(key: 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End' | 'Delete') {
    act(() => {
      // The focused tab owns strip navigation, so the event starts there.
      container
        ?.querySelector('[role="tab"][aria-selected="true"]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    });
  }

  it('moves between tabs with arrow keys', () => {
    openNode('a');
    openNode('b');
    render([canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')]);

    arrow('ArrowLeft');

    expect(activeTabName()).toBe('Alpha (note)');
  });

  it('wraps around the ends', () => {
    openNode('a');
    openNode('b');
    render([canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')]);

    // Active is the last tab, so ArrowRight wraps to the first.
    arrow('ArrowRight');

    expect(activeTabName()).toBe('Alpha (note)');
  });

  it('jumps to the ends with Home and End', () => {
    openNode('a');
    openNode('b');
    openNode('c');
    render([
      canvasNode('a', 'Alpha'),
      canvasNode('b', 'Beta'),
      canvasNode('c', 'Gamma'),
    ]);

    arrow('Home');
    expect(activeTabName()).toBe('Alpha (note)');

    arrow('End');
    expect(activeTabName()).toBe('Gamma (note)');
  });

  it('closes the active tab with Delete', () => {
    openNode('a');
    openNode('b');
    render([canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')]);

    arrow('Delete');

    expect(tabs()).toHaveLength(1);
    expect(activeTabName()).toBe('Alpha (note)');
  });

  it('keeps exactly one tab in the tab order', () => {
    openNode('a');
    openNode('b');
    render([canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')]);

    expect(
      tabs().filter((t) => t.getAttribute('tabindex') === '0'),
    ).toHaveLength(1);
  });

  it('keeps sortable tabs available to the keyboard drag sensor', () => {
    openNode('a');
    openNode('b');
    openNode('c');
    render([
      canvasNode('a', 'Alpha'),
      canvasNode('b', 'Beta'),
      canvasNode('c', 'Gamma'),
    ]);

    expect(tabs().every((tab) => tab.getAttribute('role') === 'tab')).toBe(
      true,
    );
    expect(tabs().every((tab) => tab.hasAttribute('aria-describedby'))).toBe(
      true,
    );
  });
});

describe('split', () => {
  it('renders one group until a tab is opened to the side', () => {
    openNode('a');
    openNode('b');
    render([canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')]);

    expect(container?.querySelectorAll('[role="tablist"]')).toHaveLength(1);

    act(() => {
      store().openPreviewTarget(
        { kind: 'node', canvasId: CANVAS_ID, nodeId: 'b' },
        { openToSide: true },
      );
    });

    expect(container?.querySelectorAll('[role="tablist"]')).toHaveLength(2);
    expect(container?.querySelector('[role="separator"]')).not.toBeNull();
  });

  it('mounts the active tab of each group', () => {
    openNode('a');
    openNode('b');
    render([canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')]);
    act(() => {
      store().openPreviewTarget(
        { kind: 'node', canvasId: CANVAS_ID, nodeId: 'b' },
        { openToSide: true },
      );
    });

    const mounted = Array.from(
      container?.querySelectorAll('[data-preview-node-id]') ?? [],
    ).map((el) => el.getAttribute('data-preview-node-id'));
    expect(mounted).toEqual(['a', 'b']);
  });

  it('offers an ordinary node beside a chat as a source candidate', () => {
    openNode('a');
    const threadId = useChatStore.getState().createThread();
    store().openPreviewTarget({ kind: 'chat', canvasId: CANVAS_ID, threadId });
    store().openPreviewTarget(
      { kind: 'chat', canvasId: CANVAS_ID, threadId },
      { openToSide: true },
    );
    render([canvasNode('a', 'Alpha')]);

    expect(
      container
        ?.querySelector('[data-testid="chat-panel"]')
        ?.getAttribute('data-adjacent-node-source-id'),
    ).toBe('a');
  });

  it('bounds warm retention independently in each group', async () => {
    openNode('a');
    openNode('b');
    openNode('c');
    store().openPreviewTarget(
      { kind: 'node', canvasId: CANVAS_ID, nodeId: 'c' },
      { openToSide: true },
    );
    openNode('d');
    render([
      canvasNode('a', 'Alpha'),
      canvasNode('b', 'Beta'),
      canvasNode('c', 'Gamma'),
      canvasNode('d', 'Delta'),
    ]);
    await flushActivityWork();

    const mounted = Array.from(
      container?.querySelectorAll('[data-preview-node-id]') ?? [],
    ).map((el) => el.getAttribute('data-preview-node-id'));
    expect(mounted).toEqual(['a', 'b', 'c', 'd']);
    expect(
      container?.querySelectorAll('[data-preview-active="false"]'),
    ).toHaveLength(2);
  });

  it('renders one visual divider between split groups', () => {
    openNode('a');
    openNode('b');
    render([canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')]);
    act(() => {
      store().openPreviewTarget(
        { kind: 'node', canvasId: CANVAS_ID, nodeId: 'b' },
        { openToSide: true },
      );
    });

    const groups = container?.querySelectorAll('[role="region"]');
    const separator = container?.querySelector(
      '[role="separator"][aria-valuenow]',
    );
    expect(
      Array.from(groups ?? []).some((group) =>
        group.classList.contains('ring-1'),
      ),
    ).toBe(false);
    expect(separator?.children).toHaveLength(1);
    expect(separator?.classList.contains('-mx-1')).toBe(true);
    expect(separator?.firstElementChild?.classList.contains('w-px')).toBe(true);
  });

  it('routes an editor focus request only to its target tab', () => {
    openNode('a');
    const targetTabId = openNode('b');
    store().openPreviewTarget(
      { kind: 'node', canvasId: CANVAS_ID, nodeId: 'b' },
      { openToSide: true },
    );
    store().requestNodeFocus(targetTabId);
    render([canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')]);

    const previews = Array.from(
      container?.querySelectorAll('[data-preview-node-id]') ?? [],
    );
    const firstFocusNonce = previews
      .find((preview) => preview.getAttribute('data-preview-node-id') === 'a')
      ?.getAttribute('data-focus-request-nonce');
    const secondFocusNonce = previews
      .find((preview) => preview.getAttribute('data-preview-node-id') === 'b')
      ?.getAttribute('data-focus-request-nonce');
    expect(firstFocusNonce).toBeNull();
    expect(secondFocusNonce).toBe('1');
  });

  it('nudges the split ratio from the separator keyboard', () => {
    openNode('a');
    openNode('b');
    render([canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')]);
    act(() => {
      store().openPreviewTarget(
        { kind: 'node', canvasId: CANVAS_ID, nodeId: 'b' },
        { openToSide: true },
      );
    });
    const before = store().workspace.splitRatio;

    act(() => {
      container
        ?.querySelector('[role="separator"]')
        ?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
        );
    });

    expect(store().workspace.splitRatio).toBeLessThan(before);
  });

  it('keeps moving the split while the key repeats', () => {
    openNode('a');
    openNode('b');
    render([canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')]);
    act(() => {
      store().openPreviewTarget(
        { kind: 'node', canvasId: CANVAS_ID, nodeId: 'b' },
        { openToSide: true },
      );
    });

    // A held key fires many times before React re-renders, so a handler
    // reading the render-time ratio would stop after the first press.
    act(() => {
      const separator = container?.querySelector('[role="separator"]');
      for (let i = 0; i < 20; i += 1) {
        separator?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
        );
      }
    });

    expect(store().workspace.splitRatio).toBeCloseTo(0.2, 5);
  });

  it('widens the left group when the separator is dragged right', () => {
    openNode('a');
    openNode('b');
    render([canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')]);
    act(() => {
      store().openPreviewTarget(
        { kind: 'node', canvasId: CANVAS_ID, nodeId: 'b' },
        { openToSide: true },
      );
    });

    const separator = container?.querySelector<HTMLElement>(
      '[role="separator"][aria-valuenow]',
    );
    const workspace = separator?.parentElement;
    expect(separator).toBeDefined();
    expect(workspace).toBeDefined();
    vi.spyOn(workspace as HTMLElement, 'getBoundingClientRect').mockReturnValue(
      {
        x: 100,
        y: 0,
        left: 100,
        top: 0,
        right: 500,
        bottom: 600,
        width: 400,
        height: 600,
        toJSON: () => ({}),
      },
    );
    (separator as HTMLElement).setPointerCapture = vi.fn();
    (separator as HTMLElement).releasePointerCapture = vi.fn();
    (separator as HTMLElement).hasPointerCapture = vi.fn(() => true);
    vi.spyOn(separator as HTMLElement, 'getBoundingClientRect').mockReturnValue(
      {
        x: 296,
        y: 0,
        left: 296,
        top: 0,
        right: 304,
        bottom: 600,
        width: 8,
        height: 600,
        toJSON: () => ({}),
      },
    );

    act(() => {
      separator?.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          clientX: 300,
          pointerId: 1,
        }),
      );
      window.dispatchEvent(
        new PointerEvent('pointermove', { clientX: 140, pointerId: 2 }),
      );
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2 }));
      expect(store().workspace.splitRatio).toBe(0.5);
      window.dispatchEvent(
        new PointerEvent('pointermove', { clientX: 340, pointerId: 1 }),
      );
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
    });

    expect(store().workspace.splitRatio).toBeCloseTo(0.6, 5);
  });

  it('collapses back to one group when the side group empties', () => {
    openNode('a');
    openNode('b');
    render([canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')]);
    act(() => {
      store().openPreviewTarget(
        { kind: 'node', canvasId: CANVAS_ID, nodeId: 'b' },
        { openToSide: true },
      );
    });

    const sideTab = store().workspace.groups[1].tabIds[0];
    act(() => store().closeTab(sideTab));

    expect(container?.querySelectorAll('[role="tablist"]')).toHaveLength(1);
  });

  it('answers Escape in the focused group only', () => {
    const firstTab = openNode('a');
    openNode('b');
    render([canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')]);
    act(() => {
      store().openPreviewTarget(
        { kind: 'node', canvasId: CANVAS_ID, nodeId: 'b' },
        { openToSide: true },
      );
    });
    const sideTab = store().workspace.groups[1].tabIds[0];

    // Both panes are mounted and both install a window-level handler, so an
    // unguarded one would close a tab in each group at once.
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });

    expect(store().workspace.tabs[sideTab]).toBeUndefined();
    expect(store().workspace.tabs[firstTab]).toBeDefined();
  });

  it('maps tab and group drop targets to model destinations', () => {
    const firstTab = openNode('a');
    const secondTab = openNode('b');
    store().openPreviewTarget(
      { kind: 'node', canvasId: CANVAS_ID, nodeId: 'b' },
      { openToSide: true },
    );
    const [firstGroup, sideGroup] = store().workspace.groups;

    expect(
      resolveTabDropDestination(store().workspace, firstTab, secondTab),
    ).toEqual({ groupId: sideGroup.id, index: 0 });
    expect(
      resolveTabDropDestination(
        store().workspace,
        secondTab,
        groupDropId(firstGroup.id),
      ),
    ).toEqual({ groupId: firstGroup.id, index: 1 });
  });
});

describe('target resolution', () => {
  it('dispatches a chat target to the Chat renderer', () => {
    store().openPreviewTarget({
      kind: 'chat',
      canvasId: CANVAS_ID,
      threadId: 'thread-1',
    });
    render([]);

    expect(
      container?.querySelector('[data-testid="chat-panel"]'),
    ).not.toBeNull();
  });

  it('reports a node that disappeared instead of rendering a blank panel', () => {
    openNode('gone');
    render([]);

    expect(container?.textContent).toContain('no longer available');
  });

  it('shows the empty state when nothing is open', () => {
    render([]);

    expect(container?.textContent).toContain('Double-click a node');
  });
});

describe('right panel host', () => {
  it('seeds one Chat only when the host becomes visible', () => {
    useCanvasStore.setState({ nodes: [], canvasId: CANVAS_ID });
    const onToggle = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() =>
      root?.render(
        <StrictMode>
          <PreviewWorkspacePanel isHostCollapsed />
        </StrictMode>,
      ),
    );
    expect(Object.keys(store().workspace.tabs)).toHaveLength(0);

    act(() =>
      root?.render(
        <StrictMode>
          <PreviewWorkspacePanel isHostCollapsed={false} onToggle={onToggle} />
        </StrictMode>,
      ),
    );

    expect(Object.values(store().workspace.tabs)).toHaveLength(1);
    expect(Object.values(store().workspace.tabs)[0].target.kind).toBe('chat');
    expect(
      container
        ?.querySelector('[data-testid="collapse-preview"]')
        ?.classList.contains('p-1.5'),
    ).toBe(true);
  });

  it('toggles fullscreen from the tab strip and exits with Escape', () => {
    openNode('a');
    useCanvasStore.setState({
      nodes: [canvasNode('a', 'Alpha')],
      canvasId: CANVAS_ID,
    });
    const onToggleFullscreen = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() =>
      root?.render(
        <PreviewWorkspacePanel
          isHostCollapsed={false}
          isFullscreen
          onToggleFullscreen={onToggleFullscreen}
        />,
      ),
    );

    const toggle = container.querySelector<HTMLElement>(
      '[data-testid="toggle-preview-fullscreen"]',
    );
    expect(toggle?.getAttribute('aria-label')).toContain('Exit');

    act(() =>
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(onToggleFullscreen).toHaveBeenCalledTimes(1);

    act(() =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
    );
    expect(onToggleFullscreen).toHaveBeenCalledTimes(2);

    const consumedEscape = new KeyboardEvent('keydown', {
      key: 'Escape',
      cancelable: true,
    });
    consumedEscape.preventDefault();
    act(() => window.dispatchEvent(consumedEscape));
    expect(onToggleFullscreen).toHaveBeenCalledTimes(2);

    const input = document.createElement('input');
    container.appendChild(input);
    act(() =>
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    expect(onToggleFullscreen).toHaveBeenCalledTimes(2);
  });
});
