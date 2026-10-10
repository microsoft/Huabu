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

import { PropertySymbol, type Window as HappyWindow } from 'happy-dom';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  afterEach,
  assert,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  rememberMessageListScrollPosition,
  restoreMessageListScrollPosition,
} from '@/components/Messages/messageListScroll';
import useCanvasStore from '@/store/canvasStore';
import { useChatStore } from '@/store/chatStore';
import {
  openPreviewNode,
  openPreviewUrl,
} from '@/store/previewWorkspace/actions';
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

import type * as AcpApi from '@/api/acp';
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
vi.mock('@/api/conversationTitles', () => ({
  queryConversationTitles: async () => ({ titles: {} }),
  setConversationTitle: vi.fn(),
}));
vi.mock('@/api/acp', async (importOriginal) => ({
  ...(await importOriginal<typeof AcpApi>()),
  listAcpProfiles: async () => ({
    profiles: [
      {
        id: 'global-profile',
        alias: 'Global Profile',
        agentletId: 'machine',
        workingDirPath: '/workspace',
        launch: { kind: 'acp-command', command: 'agent' },
      },
    ],
    selectableProfileIds: ['global-profile'],
    agentlet: null,
    agentDefaults: { profileId: 'global-profile', functionalModel: '' },
  }),
}));

vi.mock('../ChatPanel', () => ({
  ChatPanel: ({
    session,
    onCommit,
    adjacentNodeSourceId,
    renameRequestNonce,
  }: {
    session?: { threadId: string };
    onCommit?: () => void;
    adjacentNodeSourceId?: string;
    renameRequestNonce?: number;
  }) => (
    <div
      data-testid="chat-panel"
      data-thread-id={session?.threadId}
      data-adjacent-node-source-id={adjacentNodeSourceId}
      data-rename-request-nonce={renameRequestNonce}
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
const originalTryRename = useCanvasStore.getState().tryRename;

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
  // Render the real frame without performing remote network requests in unit tests.
  (document as unknown as { [PropertySymbol.window]: HappyWindow })[
    PropertySymbol.window
  ].happyDOM.settings.disableIframePageLoading = true;
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
  useCanvasStore.setState({
    nodes: [],
    canvasId: '',
    tryRename: originalTryRename,
  });
});

describe('tab-owned titles', () => {
  const titleInput = () =>
    container?.querySelector<HTMLInputElement>(
      'input[aria-label="Rename node"]',
    );
  const press = (target: Element, key: string) =>
    act(() =>
      target.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
      ),
    );

  it('shows the title only in its tab and cancels F2 editing back to that tab', () => {
    const tabId = openNode('a', true);
    render([canvasNode('a', 'Alpha')]);
    expect(
      container?.querySelector('button[aria-label="Rename node"]'),
    ).toBeNull();
    expect(container?.textContent?.match(/Alpha/g)).toHaveLength(1);
    press(tabs()[0], 'F2');
    const input = titleInput();
    assert(input);
    expect(input?.value).toBe('Alpha');
    expect(document.activeElement).toBe(input);
    expect(input?.selectionEnd).toBe(5);
    press(input, 'Escape');
    expect(titleInput()).toBeNull();
    expect(document.activeElement).toBe(tabs()[0]);
    expect(store().workspace.tabs[tabId].transient).toBe(true);
  });

  it('activates an inactive tab from its rename menu and uses the canonical node mutation', async () => {
    const tabId = openNode('a', true);
    openNode('b');
    store().requestNodeFocus(tabId);
    render([canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')]);
    const rename = vi.fn(async (_kind: string, id: string, label: string) => {
      useCanvasStore.setState((state) => ({
        nodes: state.nodes.map((node) =>
          node.id === id ? { ...node, data: { ...node.data, label } } : node,
        ),
      }));
      return true;
    });
    act(() => useCanvasStore.setState({ tryRename: rename }));
    await act(async () =>
      tabs()[0].dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 20,
        }),
      ),
    );
    const item = document.querySelector<HTMLButtonElement>('[role="menuitem"]');
    expect(item?.textContent).toContain('Rename node');
    await act(async () => item?.click());
    expect(mountedNodeId()).toBe('a');
    expect(store().nodeFocusRequest).toBeNull();
    const input = titleInput();
    assert(input);
    expect(input.value).toBe('Alpha');
    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      assert(setValue);
      setValue.call(input, 'Renamed');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => press(input, 'Enter'));
    expect(rename).toHaveBeenCalledExactlyOnceWith('node', 'a', 'Renamed');
    expect(activeTabName()).toBe('Renamed (note)');
    expect(store().workspace.tabs[tabId].transient).toBe(false);
    expect(document.activeElement).toBe(tabs()[0]);
    expect(titleInput()).toBeNull();
  });

  it('keeps rename requests scoped to the addressed group', () => {
    openNode('a');
    store().openPreviewTarget(
      { kind: 'node', canvasId: CANVAS_ID, nodeId: 'b' },
      { openToSide: true },
    );
    render([canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')]);
    press(tabs()[1], 'F2');
    expect(titleInput()?.value).toBe('Beta');
    expect(
      container?.querySelectorAll('input[aria-label="Rename node"]'),
    ).toHaveLength(1);
    const input = titleInput();
    assert(input);
    press(input, 'Escape');
    press(tabs()[0], 'F2');
    expect(titleInput()?.value).toBe('Alpha');
  });

  it('offers no rename action for URL targets or deleted nodes', () => {
    openNode('missing');
    store().openPreviewTarget({
      kind: 'url',
      canvasId: CANVAS_ID,
      url: 'https://example.com',
    });
    render([]);
    for (const tab of tabs()) {
      expect(tab.hasAttribute('aria-keyshortcuts')).toBe(false);
      press(tab, 'F2');
      act(() =>
        tab.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
        ),
      );
    }
    const menuLabels = Array.from(
      document.querySelectorAll('[role="menuitem"]'),
    ).map((item) => item.textContent);
    expect(menuLabels.filter((label) => label === 'Close')).toHaveLength(2);
    expect(menuLabels.some((label) => label?.startsWith('Rename'))).toBe(false);
    expect(titleInput()).toBeNull();
  });

  it('discards deferred rename when a transient tab is replaced or another tab is activated', () => {
    const first = store().openPreviewTarget(
      { kind: 'chat', canvasId: CANVAS_ID, threadId: 'first' },
      { transient: true },
    );
    render([]);
    press(tabs()[0], 'F2');
    expect(
      container
        ?.querySelector('[data-rename-request-nonce]')
        ?.getAttribute('data-thread-id'),
    ).toBe('first');
    act(() =>
      store().openPreviewTarget(
        { kind: 'chat', canvasId: CANVAS_ID, threadId: 'replacement' },
        { transient: true },
      ),
    );
    expect(tabs()).toHaveLength(1);
    expect(container?.querySelector('[data-rename-request-nonce]')).toBeNull();
    press(tabs()[0], 'F2');
    expect(
      container?.querySelector('[data-rename-request-nonce]'),
    ).not.toBeNull();
    act(() =>
      store().openPreviewTarget({
        kind: 'chat',
        canvasId: CANVAS_ID,
        threadId: 'other',
      }),
    );
    act(() => store().activateTab(first));
    expect(container?.querySelector('[data-rename-request-nonce]')).toBeNull();
  });
});

describe('tab strip', () => {
  it('opens a Note URL in the canonical workspace, retains the source, and keeps external opening available', async () => {
    const sourceId = openNode('a', true);
    render([canvasNode('a', 'Alpha')]);
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    let urlTabId = '';
    act(() => {
      urlTabId = openPreviewUrl('https://example.com/path', 'a');
    });
    expect(store().workspace.tabs[sourceId].transient).toBe(false);
    expect(store().workspace.tabs[urlTabId].transient).toBe(false);
    expect(tabs()).toHaveLength(2);
    expect(activeTabName()).toBe('https://example.com/path');
    expect(
      container?.querySelector('[aria-selected="true"]')?.textContent,
    ).toContain('example.com');
    const iframe = container?.querySelector('iframe');
    if (!iframe) throw new Error('Expected URL iframe');
    expect(iframe.src).toBe('https://example.com/path');
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-forms');
    expect(iframe.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(iframe.hasAttribute('srcdoc')).toBe(false);
    const external = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Open page in external browser"]',
    );
    if (!external) throw new Error('Expected external-open button');
    expect(external.textContent).toBe('');
    const address = container?.querySelector(
      'div[title="https://example.com/path"]',
    );
    expect(address?.textContent).toBe('example.com/path');
    act(() => external.click());
    expect(open).toHaveBeenCalledExactlyOnceWith(
      'https://example.com/path',
      '_blank',
      'noopener,noreferrer',
    );
    act(() => iframe.dispatchEvent(new Event('load')));
    expect(external.disabled).toBe(false);
    act(() => {
      expect(openPreviewUrl('https://EXAMPLE.com:443/path', 'a')).toBe(
        urlTabId,
      );
    });
    expect(tabs()).toHaveLength(2);
    act(() => store().activateTab(sourceId));
    await flushActivityWork();
    expect(container?.querySelector('iframe')).toBeNull();
    expect(mountedNodeId()).toBe('a');
    act(() => store().closeTab(urlTabId));
    expect(tabs()).toHaveLength(1);
    open.mockRestore();
  });

  it('does not promote a source or change topology for an unsafe URL', () => {
    const sourceId = openNode('a', true);
    const before = store().workspace;
    expect(openPreviewUrl('javascript:alert(1)', 'a')).toBe('');
    expect(store().workspace).toBe(before);
    expect(store().workspace.tabs[sourceId].transient).toBe(true);
  });

  it('promotes the source Chat and opens its URL in that group rather than the focused group', () => {
    const sourceId = store().openPreviewTarget(
      { kind: 'chat', canvasId: CANVAS_ID, threadId: 'source-thread' },
      { transient: true },
    );
    const otherId = store().openPreviewTarget(
      { kind: 'node', canvasId: CANVAS_ID, nodeId: 'other' },
      { openToSide: true, transient: true },
    );
    const otherGroupId = store().workspace.activeGroupId;
    expect(otherGroupId).not.toBe('g1');

    const urlId = openPreviewUrl(
      'https://example.com/path',
      undefined,
      'source-thread',
    );
    const workspace = store().workspace;
    expect(workspace.tabs[sourceId]).toMatchObject({
      transient: false,
      target: { kind: 'chat', threadId: 'source-thread' },
    });
    expect(workspace.tabs[urlId].transient).toBe(false);
    expect(workspace.groups.find((group) => group.id === 'g1')).toMatchObject({
      tabIds: [sourceId, urlId],
      activeTabId: urlId,
    });
    expect(
      workspace.groups.find((group) => group.id === otherGroupId),
    ).toMatchObject({
      tabIds: [otherId],
      activeTabId: otherId,
    });
    expect(workspace.tabs[otherId].transient).toBe(true);
    expect(workspace.activeGroupId).toBe('g1');
    openNode('next-inspection', true);
    expect(store().workspace.tabs[sourceId]).toBeDefined();
    expect(store().workspace.tabs[urlId]).toBeDefined();
  });

  it('promotes a source Chat while deduplicating a URL already in the other group', () => {
    const sourceId = store().openPreviewTarget(
      { kind: 'chat', canvasId: CANVAS_ID, threadId: 'source-thread' },
      { transient: true },
    );
    const urlId = store().openPreviewTarget(
      {
        kind: 'url',
        canvasId: CANVAS_ID,
        url: 'https://example.com/path?q=1#section',
      },
      { openToSide: true },
    );
    const urlGroupId = store().workspace.activeGroupId;
    store().activateTab(sourceId);

    expect(
      openPreviewUrl(
        'https://EXAMPLE.com:443/path?q=1#section',
        undefined,
        'source-thread',
      ),
    ).toBe(urlId);
    expect(
      openPreviewUrl(
        'https://example.com/path?q=1#section',
        undefined,
        'source-thread',
      ),
    ).toBe(urlId);

    const workspace = store().workspace;
    expect(Object.keys(workspace.tabs)).toHaveLength(2);
    expect(workspace.tabs[sourceId].transient).toBe(false);
    expect(workspace.groups.find((group) => group.id === 'g1')).toMatchObject({
      tabIds: [sourceId],
      activeTabId: sourceId,
    });
    expect(
      workspace.groups.find((group) => group.id === urlGroupId),
    ).toMatchObject({
      tabIds: [urlId],
      activeTabId: urlId,
    });
    expect(workspace.activeGroupId).toBe(urlGroupId);
  });

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
    expect(overlay?.classList.contains('max-w-80')).toBe(true);
    expect(overlay?.classList.contains('h-7')).toBe(true);
    const text = overlay?.querySelector('span');
    expect(text?.classList.contains('truncate')).toBe(true);
    expect(text?.classList.contains('min-w-0')).toBe(true);
    expect(text?.classList.contains('shrink')).toBe(true);
    expect(
      overlay?.querySelector('svg:last-child')?.classList.contains('shrink-0'),
    ).toBe(true);
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
    const strip = container?.querySelector('[role="tablist"]');
    expect(strip?.classList.contains('preview-tab-scrollbar')).toBe(true);
    expect(strip?.parentElement?.classList.contains('h-11')).toBe(true);
    expect(
      tabs()[0]
        .closest('.preview-tab-slot')
        ?.classList.contains('preview-tab-slot'),
    ).toBe(true);
    expect(tabs()[0].classList.contains('h-9')).toBe(false);
  });

  it('prioritizes the active pill width without shrinking tab controls', () => {
    openNode('a');
    openNode('b');
    render([canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')]);

    const [inactiveTab, activeTab] = tabs();
    expect(
      inactiveTab
        .closest('.preview-tab-slot')
        ?.classList.contains('preview-tab-slot-active'),
    ).toBe(false);
    expect(
      activeTab
        .closest('.preview-tab-slot')
        ?.classList.contains('preview-tab-slot-active'),
    ).toBe(true);
    for (const tab of [inactiveTab, activeTab]) {
      expect(
        tab
          .closest('.preview-tab-slot')
          ?.classList.contains('preview-tab-slot'),
      ).toBe(true);
      expect(tab.classList.contains('rounded-lg')).toBe(true);
      const title = tab.querySelector('[data-testid="preview-tab-title"]');
      expect(title?.classList.contains('truncate')).toBe(true);
      expect(title?.classList.contains('min-w-0')).toBe(true);
      expect(title?.classList.contains('flex-1')).toBe(true);
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
    expect(activeTab.classList.contains('border-r')).toBe(false);
    expect(activeTab.classList.contains('after:bg-info-light')).toBe(false);
    expect(activeTab.classList.contains('bg-bg-default')).toBe(true);
    const strip = activeTab.closest('[role="tablist"]');
    expect(strip?.classList.contains('overflow-x-auto')).toBe(true);
    expect(strip?.classList.contains('overflow-y-hidden')).toBe(true);
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

  it('creates a Chat tab from the workspace toolbar while a node is active', async () => {
    openNode('a');
    render([canvasNode('a', 'Alpha')]);

    const newChatButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="New conversation"]',
    );
    expect(newChatButton).not.toBeNull();
    await act(async () => newChatButton?.click());

    expect(tabs()).toHaveLength(2);
    expect(activeTabName()).toBe('New conversation');
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

  it('keeps only Close on the tab and promotes through the text-only context menu', () => {
    const tabId = openNode('a', true);
    render([canvasNode('a', 'Alpha')]);

    expect(
      container?.querySelector<HTMLButtonElement>(
        '[aria-label="Keep Alpha open"]',
      ),
    ).toBeNull();
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
    expect(title?.classList.contains('group-hover:text-fg-subtle')).toBe(false);
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(tabs()[0].classList.contains('text-fg-default')).toBe(true);
    expect(actionRail?.classList.contains('absolute')).toBe(false);
    expect(actionRail?.classList.contains('shrink-0')).toBe(true);
    expect(actionRail?.classList.contains('opacity-0')).toBe(false);
    expect(actionRail?.classList.contains('pointer-events-none')).toBe(false);
    expect(actionRail?.classList.contains('group-hover:opacity-100')).toBe(
      false,
    );
    expect(actionRail?.contains(closeButton ?? null)).toBe(true);
    expect(actionRail?.querySelectorAll('button')).toHaveLength(1);
    expect(closeButton?.classList.contains('shadow-sm')).toBe(false);
    act(() =>
      tabs()[0].dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      ),
    );
    const keepButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ).find((item) => item.textContent === 'Keep tab');
    expect(keepButton).toBeDefined();
    expect(keepButton?.querySelector('svg')).toBeNull();
    act(() => keepButton?.click());

    expect(store().workspace.tabs[tabId].transient).toBe(false);
    expect(
      container?.querySelector('[aria-label="Keep Alpha open"]'),
    ).toBeNull();
  });

  it('keeps a transient tab transient when moving it to an empty group', () => {
    const transientTabId = openNode('a', true);
    openNode('b');
    store().activateTab(transientTabId);
    store().splitGroup();
    render([canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')]);

    act(() =>
      store().moveTab(transientTabId, {
        groupId: store().workspace.groups[1].id,
      }),
    );

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

describe('tab batch close menu', () => {
  const menuItem = (label: string) =>
    Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ).find((item) => item.textContent === label);
  const openMenu = async (tabId: string) => {
    const tab = container?.querySelector(`[data-preview-tab-id="${tabId}"]`);
    expect(tab).not.toBeNull();
    await act(async () =>
      tab?.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
  };

  it.each([
    { label: 'Close other tabs', expected: ['b'] },
    { label: 'Close tabs to the right', expected: ['a', 'b'] },
    { label: 'Close all tabs in this group', expected: [] },
  ])(
    'routes "$label" through the clicked tab, not the active tab in another group',
    async ({ label, expected }) => {
      openNode('a');
      const clicked = openNode('b', true);
      openNode('c');
      store().splitGroup();
      const other = openNode('d');
      render(['a', 'b', 'c', 'd'].map((id) => canvasNode(id, id)));
      const onCollapse = vi.fn();
      act(() => root?.render(<PreviewWorkspace onCollapse={onCollapse} />));
      await openMenu(clicked);
      const action = menuItem(label);
      expect(action?.disabled).toBe(false);
      await act(async () => action?.click());
      const remaining = Object.values(store().workspace.tabs)
        .filter((tab) => tab.id !== other)
        .map((tab) => (tab.target.kind === 'node' ? tab.target.nodeId : ''));
      expect(remaining).toEqual(expected);
      expect(store().workspace.tabs[other]).toBeDefined();
      expect(store().workspace.groups).toHaveLength(expected.length ? 2 : 1);
      expect(onCollapse).not.toHaveBeenCalled();
      expect(useCanvasStore.getState().nodes).toHaveLength(4);
    },
  );

  it('disables empty batches and skips disabled menu items with keyboard navigation', async () => {
    const tabId = openNode('a');
    store().splitGroup();
    openNode('b');
    render([canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')]);
    await openMenu(tabId);
    expect(menuItem('Close other tabs')?.disabled).toBe(true);
    expect(menuItem('Close tabs to the right')?.disabled).toBe(true);
    const close = menuItem('Close');
    await act(async () => {
      close?.focus();
      close?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(
      menuItem('Close all tabs in this group'),
    );
  });

  it.each([
    'Close',
    'Close other tabs',
    'Close tabs to the right',
    'Close all tabs in this group',
  ])('restores focus to the repaired active tab after "%s"', async (label) => {
    openNode('a');
    const clicked = openNode('b');
    openNode('c');
    store().splitGroup();
    openNode('d');
    render(['a', 'b', 'c', 'd'].map((id) => canvasNode(id, id)));
    await openMenu(clicked);
    const action = menuItem(label);
    assert(action);
    await act(async () => action.focus());
    expect(document.activeElement).toBe(action);
    await act(async () => action.click());
    const workspace = store().workspace;
    const group = workspace.groups.find(
      (candidate) => candidate.id === workspace.activeGroupId,
    );
    assert(group?.activeTabId);
    expect(document.activeElement).toBe(
      container?.querySelector(`[data-preview-tab-id="${group.activeTabId}"]`),
    );
  });

  it('preserves focus in retained content when an unfocused close control is invoked', () => {
    openNode('a');
    openNode('b');
    render([canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')]);
    const retainedInput = document.createElement('input');
    container?.append(retainedInput);
    act(() => retainedInput.focus());
    act(() => tabs()[0].querySelector('button')?.click());
    expect(document.activeElement).toBe(retainedInput);
  });

  it('hands portal-menu focus to the host when the final tabs collapse', async () => {
    const first = openNode('a');
    render([canvasNode('a', 'Alpha')]);
    const destination = document.createElement('input');
    container?.append(destination);
    const onCollapse = vi.fn(() => {
      expect(document.activeElement?.getAttribute('role')).toBe('tab');
      destination.focus();
    });
    act(() => root?.render(<PreviewWorkspace onCollapse={onCollapse} />));
    await openMenu(first);
    const action = menuItem('Close all tabs in this group');
    assert(action);
    await act(async () => action.focus());
    await act(async () => action.click());
    expect(onCollapse).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(destination);
  });

  it('collapses the panel once when closing its last group of tabs', async () => {
    const first = openNode('a');
    openNode('b');
    render([canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')]);
    const onCollapse = vi.fn();
    act(() => root?.render(<PreviewWorkspace onCollapse={onCollapse} />));
    await openMenu(first);
    await act(async () => menuItem('Close all tabs in this group')?.click());
    expect(store().workspace.tabs).toEqual({});
    expect(store().workspace.groups).toHaveLength(1);
    expect(onCollapse).toHaveBeenCalledOnce();
  });
});

describe('split', () => {
  it.each([false, true])(
    'uses group-specific empty copy regardless of focus with fullscreen=%s',
    (isFullscreen) => {
      const tabId = openNode('a');
      store().splitGroup();
      render([canvasNode('a', 'Alpha')]);
      act(() => root?.render(<PreviewWorkspace isFullscreen={isFullscreen} />));
      expect(container?.textContent).toContain('No preview open in this group');
      expect(container?.textContent).not.toContain('Double-click a node');
      act(() => store().activateTab(tabId));
      expect(container?.textContent).toContain('No preview open in this group');
      expect(container?.textContent).not.toContain('Double-click a node');
    },
  );

  it.each([0, 1])(
    'closes an empty group on side %i without collapsing the panel',
    (emptyIndex) => {
      store().splitGroup();
      const emptyId = store().workspace.groups[emptyIndex].id;
      const survivingId = store().workspace.groups[1 - emptyIndex].id;
      store().setActiveGroup(survivingId);
      const tabId = openNode('a');
      render([canvasNode('a', 'Alpha')]);
      const onCollapse = vi.fn();
      act(() => root?.render(<PreviewWorkspace onCollapse={onCollapse} />));
      const close = container?.querySelectorAll<HTMLButtonElement>(
        '[aria-label="Close empty group"]',
      );
      expect(close).toHaveLength(1);
      act(() => {
        store().setActiveGroup(emptyId);
        close?.[0].focus();
        close?.[0].click();
      });
      expect(store().workspace.groups).toHaveLength(1);
      expect(store().workspace.groups[0].id).toBe(survivingId);
      expect(store().workspace.groups[0].activeTabId).toBe(tabId);
      expect(store().workspace.activeGroupId).toBe(survivingId);
      expect(document.activeElement).toBe(tabs()[0]);
      expect(onCollapse).not.toHaveBeenCalled();
      expect(
        container?.querySelector('[aria-label="Close empty group"]'),
      ).toBeNull();
    },
  );

  it('keeps one empty group after explicitly closing the other', () => {
    store().splitGroup();
    render([]);
    const close = container?.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Close empty group"]',
    );
    expect(close).toHaveLength(2);
    act(() => {
      close?.[1].focus();
      close?.[1].click();
    });
    expect(container?.querySelectorAll('[role="tablist"]')).toHaveLength(1);
    expect(
      container?.querySelector('[aria-label="Close empty group"]'),
    ).toBeNull();
    expect(store().workspace.groups[0].tabIds).toEqual([]);
    expect(document.activeElement).toBe(
      container?.querySelector('button[aria-label="New conversation"]'),
    );
  });

  it.each([0, 1, 3])(
    'creates an empty right group from the toolbar with %i tabs',
    (count) => {
      const nodes = Array.from({ length: count }, (_, index) =>
        canvasNode(`n${index}`, `Node ${index}`),
      );
      nodes.forEach((node) => openNode(node.id));
      render(nodes);
      const original = store().workspace.groups[0];
      const split = container?.querySelector<HTMLButtonElement>(
        '[aria-label="Split: create an empty group on the right"]',
      );
      expect(split).not.toBeNull();
      act(() => split?.click());
      expect(store().workspace.groups[0]).toEqual(original);
      expect(store().workspace.groups[1].tabIds).toEqual([]);
      expect(store().workspace.activeGroupId).toBe(
        store().workspace.groups[1].id,
      );
      expect(container?.querySelectorAll('[role="tablist"]')).toHaveLength(2);
      expect(container?.querySelector('[role="separator"]')).not.toBeNull();
      expect(container?.textContent).toContain('No preview open in this group');
      expect(
        container?.querySelector('[aria-label="Merge groups"]'),
      ).toBeNull();
      expect(
        container?.querySelector('[aria-label="Move tab to the other group"]'),
      ).toBeNull();
      expect(Object.keys(store().workspace.tabs)).toHaveLength(count);
    },
  );

  it('routes canvas node opens to the last interacted group, reusing existing targets', () => {
    render([
      canvasNode('a', 'Alpha'),
      canvasNode('b', 'Beta'),
      canvasNode('c', 'Gamma'),
    ]);
    act(() => store().splitGroup());
    const [left, right] = store().workspace.groups;
    let firstTab = '';
    act(() => {
      firstTab = openPreviewNode('a');
    });
    expect(store().workspace.groups[1].tabIds).toEqual([firstTab]);
    const leftPanel = container?.querySelectorAll('[role="tabpanel"]')[0];
    act(() =>
      leftPanel?.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true }),
      ),
    );
    expect(store().workspace.activeGroupId).toBe(left.id);
    let secondTab = '';
    act(() => {
      secondTab = openPreviewNode('b');
    });
    expect(store().workspace.groups[0].tabIds).toEqual([secondTab]);
    act(() => {
      expect(openPreviewNode('a')).toBe(firstTab);
    });
    expect(store().workspace.activeGroupId).toBe(right.id);
    act(() => {
      expect(openPreviewNode('c')).toBe(firstTab);
    });
    expect(store().workspace.tabs[secondTab].target).toMatchObject({
      nodeId: 'b',
    });
    expect(store().workspace.tabs[firstTab].target).toMatchObject({
      nodeId: 'c',
    });
  });

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
    const threadId = useChatStore
      .getState()
      .createThread({ binding: { kind: 'internal' } });
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

    expect(tabs()[0].querySelector('.lucide-message-circle')).not.toBeNull();
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

    expect(container?.textContent).toContain('No preview open in this group');
  });
});

describe('right panel host', () => {
  it('does not seed a Chat into a restored empty split', () => {
    store().splitGroup();
    useCanvasStore.setState({ nodes: [], canvasId: CANVAS_ID });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<PreviewWorkspacePanel />));
    expect(Object.keys(store().workspace.tabs)).toHaveLength(0);
    expect(container.querySelectorAll('[role="tablist"]')).toHaveLength(2);
  });

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
    const collapse = container?.querySelector<HTMLButtonElement>(
      '[data-testid="collapse-preview"]',
    );
    const newChat = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="New conversation"]:not([role="tab"])',
    );
    expect(collapse?.classList.contains('p-1.5')).toBe(true);
    expect(collapse?.className).toBe(newChat?.className);
    expect(collapse?.querySelector('.lucide-panel-right-close')).not.toBeNull();
    expect(newChat?.querySelector('.lucide-plus')).not.toBeNull();
    for (const button of [newChat, collapse]) {
      expect(button?.classList.contains('text-fg-subtle')).toBe(true);
      expect(button?.classList.contains('enabled:hover:text-fg-default')).toBe(
        true,
      );
      expect(button?.classList.contains('[&_svg]:h-4')).toBe(true);
      expect(button?.classList.contains('[&_svg]:w-4')).toBe(true);
      expect(button?.querySelector('svg')?.matches('.lucide')).toBe(true);
    }
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
    expect(toggle?.getAttribute('aria-label')).toBe('Exit fullscreen');
    expect(toggle?.querySelector('.lucide-minimize')).not.toBeNull();

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

    act(() =>
      root?.render(
        <PreviewWorkspacePanel
          isHostCollapsed={false}
          isFullscreen={false}
          onToggleFullscreen={onToggleFullscreen}
        />,
      ),
    );
    const enterToggle = container.querySelector<HTMLElement>(
      '[data-testid="toggle-preview-fullscreen"]',
    );
    expect(enterToggle?.getAttribute('aria-label')).toBe('Fullscreen');
    expect(enterToggle?.querySelector('.lucide-maximize')).not.toBeNull();
  });
});
