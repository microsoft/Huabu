// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Store-level tests. The topology rules are already covered against the pure
 * reducers in `model.test.ts`, so these assert only what the binding adds:
 * which Canvas is loaded, when the record is written, and that each action
 * reaches its reducer.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createEmptyWorkspace, openTarget, type PreviewTarget } from './model';
import { readWorkspace, writeWorkspace } from './persistence';
import {
  selectActiveNodeId,
  selectActiveTab,
  selectGroupOfTab,
  usePreviewWorkspaceStore,
} from './store';

const testStorage = vi.hoisted(() => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  });
  return { storage };
});

const CANVAS = 'canvas-1';
const OTHER = 'canvas-2';

function node(nodeId: string, canvasId = CANVAS): PreviewTarget {
  return { kind: 'node', canvasId, nodeId };
}

function chat(threadId: string, canvasId = CANVAS): PreviewTarget {
  return { kind: 'chat', canvasId, threadId };
}

const store = () => usePreviewWorkspaceStore.getState();

beforeEach(() => {
  testStorage.storage.clear();
  usePreviewWorkspaceStore.setState({
    canvasId: '',
    workspace: createEmptyWorkspace(),
    nodeFocusRequest: null,
    nodeFocusRequestSeq: 0,
    chatOpenRequest: null,
    chatOpenRequestSeq: 0,
  });
});

describe('loading a Canvas', () => {
  it('restores a persisted layout', () => {
    const persisted = openTarget(
      createEmptyWorkspace('g1'),
      node('a'),
      {},
      { tabId: 't1' },
    ).workspace;
    writeWorkspace(CANVAS, persisted);

    store().loadForCanvas(CANVAS);

    expect(store().canvasId).toBe(CANVAS);
    expect(store().workspace).toEqual(persisted);
  });

  it('seeds from pre-workspace Chat state when nothing is persisted', () => {
    store().loadForCanvas(CANVAS, { chatThreadId: 'thread-1' });

    const tabs = Object.values(store().workspace.tabs);
    expect(tabs).toHaveLength(1);
    expect(tabs[0].target).toEqual(chat('thread-1'));
  });

  it('prefers the persisted layout over the legacy seed', () => {
    const persisted = openTarget(
      createEmptyWorkspace('g1'),
      node('a'),
      {},
      { tabId: 't1' },
    ).workspace;
    writeWorkspace(CANVAS, persisted);

    store().loadForCanvas(CANVAS, { chatThreadId: 'thread-1' });

    expect(store().workspace).toEqual(persisted);
  });

  it('falls back to an empty workspace', () => {
    store().loadForCanvas(CANVAS);

    expect(store().workspace.tabs).toEqual({});
    expect(store().workspace.groups).toHaveLength(1);
  });

  it('reloading the same Canvas keeps the in-memory layout', () => {
    store().loadForCanvas(CANVAS);
    store().openPreviewTarget(node('a'));
    const afterOpen = store().workspace;

    store().loadForCanvas(CANVAS);

    expect(store().workspace).toBe(afterOpen);
  });

  it('flushes the outgoing Canvas before switching', () => {
    store().loadForCanvas(CANVAS);
    store().openPreviewTarget(node('a'));

    store().loadForCanvas(OTHER);

    expect(store().canvasId).toBe(OTHER);
    const restored = readWorkspace(CANVAS);
    expect(Object.values(restored?.tabs ?? {}).map((t) => t.target)).toEqual([
      node('a'),
    ]);
  });
});

describe('flushing', () => {
  it('writes the loaded Canvas', () => {
    store().loadForCanvas(CANVAS);
    store().openPreviewTarget(node('a'));

    store().flush();

    expect(readWorkspace(CANVAS)).toEqual(store().workspace);
  });

  it('writes nothing before a Canvas is loaded', () => {
    store().flush();

    expect(readWorkspace('')).toBeNull();
  });
});

describe('actions delegate to the model', () => {
  beforeEach(() => {
    store().loadForCanvas(CANVAS);
  });

  it('opens a target and returns its tab id', () => {
    const tabId = store().openPreviewTarget(node('a'));

    expect(tabId).toBeTruthy();
    expect(store().workspace.tabs[tabId].target).toEqual(node('a'));
  });

  it('reveals an already-open target instead of duplicating it', () => {
    const first = store().openPreviewTarget(node('a'));
    const second = store().openPreviewTarget(node('a'));

    expect(second).toBe(first);
    expect(Object.keys(store().workspace.tabs)).toHaveLength(1);
  });

  it('closes a tab', () => {
    const tabId = store().openPreviewTarget(node('a'));
    const beforeTabRemoved = vi.fn();

    store().closeTab(tabId, beforeTabRemoved);

    expect(beforeTabRemoved).toHaveBeenCalledWith(tabId);
    expect(store().workspace.tabs[tabId]).toBeUndefined();
  });

  it('activates a tab', () => {
    const first = store().openPreviewTarget(node('a'));
    store().openPreviewTarget(node('b'));

    store().activateTab(first);

    expect(selectActiveTab(store())?.id).toBe(first);
  });

  it('promotes a transient tab', () => {
    const tabId = store().openPreviewTarget(node('a'), { transient: true });
    expect(store().workspace.tabs[tabId].transient).toBe(true);

    store().promoteTab(tabId);

    expect(store().workspace.tabs[tabId].transient).toBe(false);
  });

  it('moves a tab to the other group', () => {
    const tabId = store().openPreviewTarget(node('a'));
    store().openPreviewTarget(node('b'), { openToSide: true });
    const sideGroupId = store().workspace.groups[1].id;

    store().moveTab(tabId, { groupId: sideGroupId });

    expect(selectGroupOfTab(store(), tabId)).toBe(sideGroupId);
  });

  it('settles and clears runtime requests for a transient removed by a move', () => {
    const moved = store().openPreviewTarget(node('a'), { transient: true });
    const removed = store().openPreviewTarget(node('b'), {
      transient: true,
      openToSide: true,
    });
    const sideGroupId = store().workspace.groups[1].id;
    store().requestNodeFocus(removed);
    store().requestChatOpen(removed, 'bottom');
    const beforeTabRemoved = vi.fn((tabId: string) => {
      expect(store().workspace.tabs[tabId]).toBeDefined();
    });

    store().moveTab(moved, { groupId: sideGroupId }, beforeTabRemoved);

    expect(beforeTabRemoved).toHaveBeenCalledOnce();
    expect(beforeTabRemoved).toHaveBeenCalledWith(removed);
    expect(store().workspace.tabs[removed]).toBeUndefined();
    expect(store().nodeFocusRequest).toBeNull();
    expect(store().chatOpenRequest).toBeNull();
  });

  it('replaces a tab target in place', () => {
    const tabId = store().openPreviewTarget(chat('thread-1'));

    store().replaceTabTarget(tabId, node('question-1'));

    expect(store().workspace.tabs[tabId].target).toEqual(node('question-1'));
  });

  it('merges groups', () => {
    store().openPreviewTarget(node('a'));
    store().openPreviewTarget(node('b'), { openToSide: true });
    expect(store().workspace.groups).toHaveLength(2);

    store().mergeGroups();

    expect(store().workspace.groups).toHaveLength(1);
    expect(store().workspace.groups[0].tabIds).toHaveLength(2);
  });

  it('settles and clears runtime requests for a transient removed by merge', () => {
    const removed = store().openPreviewTarget(node('a'), { transient: true });
    const kept = store().openPreviewTarget(node('b'), {
      transient: true,
      openToSide: true,
    });
    store().requestNodeFocus(removed);
    store().requestChatOpen(removed, 'last-user');
    const beforeTabRemoved = vi.fn();

    store().mergeGroups(beforeTabRemoved);

    expect(beforeTabRemoved).toHaveBeenCalledWith(removed);
    expect(store().workspace.tabs[removed]).toBeUndefined();
    expect(store().workspace.tabs[kept]).toBeDefined();
    expect(store().nodeFocusRequest).toBeNull();
    expect(store().chatOpenRequest).toBeNull();
  });

  it('sets the active group', () => {
    store().openPreviewTarget(node('a'));
    const firstGroupId = store().workspace.groups[0].id;
    store().openPreviewTarget(node('b'), { openToSide: true });

    store().setActiveGroup(firstGroupId);

    expect(store().workspace.activeGroupId).toBe(firstGroupId);
  });

  it('clamps the split ratio', () => {
    store().setSplitRatio(0.95);

    expect(store().workspace.splitRatio).toBeLessThan(0.95);
  });

  it('drops tabs whose node is gone', () => {
    store().openPreviewTarget(node('a'));
    const kept = store().openPreviewTarget(node('b'));

    store().validate(new Set(['b']));

    expect(Object.keys(store().workspace.tabs)).toEqual([kept]);
  });

  it('clears runtime requests for tabs removed by validation', () => {
    const removed = store().openPreviewTarget(node('a'));
    store().requestNodeFocus(removed);
    store().requestChatOpen(removed, 'last-user');

    store().validate(new Set());

    expect(store().nodeFocusRequest).toBeNull();
    expect(store().chatOpenRequest).toBeNull();
  });

  it('validates nothing before a Canvas is loaded', () => {
    usePreviewWorkspaceStore.setState({
      canvasId: '',
      workspace: createEmptyWorkspace(),
    });

    expect(() => store().validate(new Set())).not.toThrow();
  });
});

describe('node focus requests', () => {
  it('reissues focus for the same tab and consumes only the matching request', () => {
    store().requestNodeFocus('tab-1');
    const firstNonce = store().nodeFocusRequest?.nonce;
    store().requestNodeFocus('tab-1');

    expect(store().nodeFocusRequest).toEqual({
      tabId: 'tab-1',
      nonce: (firstNonce ?? 0) + 1,
    });

    store().consumeNodeFocusRequest('tab-1', firstNonce ?? 0);
    expect(store().nodeFocusRequest).not.toBeNull();

    store().consumeNodeFocusRequest(
      'tab-1',
      store().nodeFocusRequest?.nonce ?? 0,
    );
    expect(store().nodeFocusRequest).toBeNull();

    store().requestNodeFocus('tab-1');
    expect(store().nodeFocusRequest?.nonce).toBe((firstNonce ?? 0) + 2);
    store().closeTab('tab-1');
    expect(store().nodeFocusRequest).toBeNull();
  });
});

describe('Chat open requests', () => {
  it('reissues positioning for the same tab and consumes only the matching request', () => {
    store().requestChatOpen('tab-1', 'last-user');
    const firstNonce = store().chatOpenRequest?.nonce;
    store().requestChatOpen('tab-1', 'bottom');

    expect(store().chatOpenRequest).toEqual({
      tabId: 'tab-1',
      position: 'bottom',
      nonce: (firstNonce ?? 0) + 1,
    });

    store().consumeChatOpenRequest('tab-1', firstNonce ?? 0);
    expect(store().chatOpenRequest).not.toBeNull();

    store().consumeChatOpenRequest(
      'tab-1',
      store().chatOpenRequest?.nonce ?? 0,
    );
    expect(store().chatOpenRequest).toBeNull();

    store().requestChatOpen('tab-1', 'last-user');
    store().closeTab('tab-1');
    expect(store().chatOpenRequest).toBeNull();
  });
});

describe('tab retention', () => {
  it('keeps permanent tabs beyond the former per-group limit', () => {
    store().loadForCanvas(CANVAS);
    const opened = Array.from({ length: 20 }, (_, index) =>
      store().openPreviewTarget(node(`n${index}`)),
    );

    expect(store().workspace.groups[0].tabIds).toEqual(opened);
    expect(Object.keys(store().workspace.tabs)).toHaveLength(20);
  });
});

describe('selectors', () => {
  beforeEach(() => {
    store().loadForCanvas(CANVAS);
  });

  it('reports the focused group active node', () => {
    store().openPreviewTarget(node('a'));

    expect(selectActiveNodeId(store())).toBe('a');
  });

  it('reports no node while a Chat tab is active', () => {
    store().openPreviewTarget(chat('thread-1'));

    expect(selectActiveNodeId(store())).toBeNull();
    expect(selectActiveTab(store())?.target.kind).toBe('chat');
  });

  it('reports no active tab on an empty workspace', () => {
    expect(selectActiveTab(store())).toBeNull();
    expect(selectActiveNodeId(store())).toBeNull();
  });

  it('reports no group for a tab that is not open', () => {
    expect(selectGroupOfTab(store(), 'missing')).toBeNull();
  });
});
