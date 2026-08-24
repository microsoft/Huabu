// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createEmptyWorkspace, openTarget, type PreviewTarget } from './model';
import {
  MAX_PERSISTED_CANVASES,
  deleteWorkspace,
  readPersistedCanvasIndex,
  readWorkspace,
  seedWorkspaceFromLegacyChat,
  writeWorkspace,
} from './persistence';
import {
  messageListViewKey,
  rememberMessageListScrollPosition,
  restoreMessageListScrollPosition,
} from './scrollMemory';

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
  return { storage, values };
});

const CANVAS = 'canvas-1';
const KEY = `huabu.previewWorkspace.${CANVAS}`;

function node(nodeId: string, canvasId = CANVAS): PreviewTarget {
  return { kind: 'node', canvasId, nodeId };
}

function sampleWorkspace() {
  let ws = createEmptyWorkspace('g1');
  ws = openTarget(ws, node('a'), {}, { tabId: 't1' }).workspace;
  ws = openTarget(ws, node('b'), {}, { tabId: 't2' }).workspace;
  return ws;
}

beforeEach(() => {
  testStorage.storage.clear();
});

describe('workspace round trip', () => {
  it('restores tabs, groups, focus, and split ratio', () => {
    const ws = sampleWorkspace();
    writeWorkspace(CANVAS, ws);

    const restored = readWorkspace(CANVAS);
    expect(restored).toEqual(ws);
  });

  it('restores two groups', () => {
    let ws = sampleWorkspace();
    ws = openTarget(
      ws,
      node('c'),
      { openToSide: true },
      { tabId: 't3', groupId: 'g2' },
    ).workspace;
    writeWorkspace(CANVAS, ws);

    const restored = readWorkspace(CANVAS);
    expect(restored?.groups).toHaveLength(2);
    expect(restored?.groups[1].tabIds).toEqual(['t3']);
    expect(restored?.activeGroupId).toBe('g2');
  });

  it('returns null for an unknown canvas', () => {
    expect(readWorkspace('missing')).toBeNull();
    expect(readWorkspace('')).toBeNull();
  });
});

describe('defensive parsing', () => {
  it('treats unparseable payloads as missing layout', () => {
    testStorage.storage.setItem(KEY, 'not json');
    expect(readWorkspace(CANVAS)).toBeNull();
  });

  it('rejects a record written by a different schema version', () => {
    const ws = sampleWorkspace();
    testStorage.storage.setItem(
      KEY,
      JSON.stringify({ version: 999, workspace: ws }),
    );
    expect(readWorkspace(CANVAS)).toBeNull();
  });

  it('drops tabs whose target cannot be resolved', () => {
    testStorage.storage.setItem(
      KEY,
      JSON.stringify({
        version: 1,
        workspace: {
          tabs: {
            good: { id: 'good', target: node('a') },
            bad: { id: 'bad', target: { kind: 'mystery', canvasId: CANVAS } },
            alsoBad: { id: 'alsoBad' },
          },
          groups: [{ id: 'g1', tabIds: ['good', 'bad', 'alsoBad'] }],
          activeGroupId: 'g1',
        },
      }),
    );

    const restored = readWorkspace(CANVAS);
    expect(Object.keys(restored?.tabs ?? {})).toEqual(['good']);
    expect(restored?.groups[0].tabIds).toEqual(['good']);
    expect(restored?.groups[0].activeTabId).toBe('good');
  });

  it('drops chat targets from another Canvas and empty thread ids', () => {
    testStorage.storage.setItem(
      KEY,
      JSON.stringify({
        version: 1,
        workspace: {
          tabs: {
            good: {
              id: 'good',
              target: { kind: 'chat', canvasId: CANVAS, threadId: 'thread-1' },
            },
            wrongCanvas: {
              id: 'wrongCanvas',
              target: {
                kind: 'chat',
                canvasId: 'canvas-2',
                threadId: 'thread-2',
              },
            },
            empty: {
              id: 'empty',
              target: { kind: 'chat', canvasId: CANVAS, threadId: '' },
            },
          },
          groups: [{ id: 'g1', tabIds: ['good', 'wrongCanvas', 'empty'] }],
          activeGroupId: 'g1',
        },
      }),
    );

    const restored = readWorkspace(CANVAS);
    expect(Object.keys(restored?.tabs ?? {})).toEqual(['good']);
    expect(restored?.groups[0].tabIds).toEqual(['good']);
    expect(restored?.tabs.good.target).toEqual({
      kind: 'chat',
      canvasId: CANVAS,
      threadId: 'thread-1',
    });
  });

  it('repairs a dangling active tab and a bad split ratio', () => {
    testStorage.storage.setItem(
      KEY,
      JSON.stringify({
        version: 1,
        workspace: {
          tabs: { t1: { id: 't1', target: node('a') } },
          groups: [{ id: 'g1', tabIds: ['t1'], activeTabId: 'gone' }],
          activeGroupId: 'nope',
          splitRatio: 'wide',
        },
      }),
    );

    const restored = readWorkspace(CANVAS);
    expect(restored?.groups[0].activeTabId).toBe('t1');
    expect(restored?.activeGroupId).toBe('g1');
    expect(restored?.splitRatio).toBe(0.5);
  });

  it('drops older duplicate transient tabs within one group', () => {
    testStorage.storage.setItem(
      KEY,
      JSON.stringify({
        version: 1,
        workspace: {
          tabs: {
            t1: {
              id: 't1',
              target: node('a'),
              transient: true,
              lastActiveSeq: 1,
            },
            t2: {
              id: 't2',
              target: node('b'),
              transient: true,
              lastActiveSeq: 2,
            },
          },
          groups: [{ id: 'g1', tabIds: ['t1', 't2'], activeTabId: 't2' }],
          activeGroupId: 'g1',
          activationSeq: 2,
        },
      }),
    );

    const restored = readWorkspace(CANVAS);
    expect(restored?.tabs.t1).toBeUndefined();
    expect(restored?.tabs.t2.transient).toBe(true);
    expect(restored?.groups[0].tabIds).toEqual(['t2']);
  });

  it('drops a tab claimed by two groups and discards orphans', () => {
    testStorage.storage.setItem(
      KEY,
      JSON.stringify({
        version: 1,
        workspace: {
          tabs: {
            t1: { id: 't1', target: node('a') },
            orphan: { id: 'orphan', target: node('b') },
          },
          groups: [
            { id: 'g1', tabIds: ['t1'] },
            { id: 'g2', tabIds: ['t1'] },
          ],
          activeGroupId: 'g1',
        },
      }),
    );

    const restored = readWorkspace(CANVAS);
    expect(Object.keys(restored?.tabs ?? {})).toEqual(['t1']);
    expect(restored?.groups).toHaveLength(1);
  });

  it('never restores more than two groups', () => {
    testStorage.storage.setItem(
      KEY,
      JSON.stringify({
        version: 1,
        workspace: {
          tabs: {
            t1: { id: 't1', target: node('a') },
            t2: { id: 't2', target: node('b') },
            t3: { id: 't3', target: node('c') },
          },
          groups: [
            { id: 'g1', tabIds: ['t1'] },
            { id: 'g2', tabIds: ['t2'] },
            { id: 'g3', tabIds: ['t3'] },
          ],
          activeGroupId: 'g1',
        },
      }),
    );

    const restored = readWorkspace(CANVAS);
    expect(restored?.groups).toHaveLength(2);
    expect(Object.keys(restored?.tabs ?? {}).sort()).toEqual(['t1', 't2']);
  });

  it('returns null when nothing survives repair', () => {
    testStorage.storage.setItem(
      KEY,
      JSON.stringify({ version: 1, workspace: { tabs: {}, groups: [] } }),
    );
    expect(readWorkspace(CANVAS)).toBeNull();
  });
});

describe('canvas index', () => {
  it('tracks most recently written canvases first', () => {
    writeWorkspace('c1', sampleWorkspace());
    writeWorkspace('c2', sampleWorkspace());
    writeWorkspace('c1', sampleWorkspace());

    expect(readPersistedCanvasIndex()).toEqual(['c1', 'c2']);
  });

  it('deletes the layout of canvases pushed past the cap', () => {
    const viewKey = messageListViewKey('c0', 'thread-0');
    rememberMessageListScrollPosition(viewKey, 100);
    for (let i = 0; i <= MAX_PERSISTED_CANVASES; i += 1) {
      writeWorkspace(`c${i}`, sampleWorkspace());
    }

    const index = readPersistedCanvasIndex();
    expect(index).toHaveLength(MAX_PERSISTED_CANVASES);
    expect(index).not.toContain('c0');
    expect(readWorkspace('c0')).toBeNull();
    expect(readWorkspace('c1')).not.toBeNull();
    expect(
      restoreMessageListScrollPosition(document.createElement('div'), viewKey),
    ).toBe(false);
  });

  it('removes the record and the index entry on canvas delete', () => {
    writeWorkspace('c1', sampleWorkspace());
    writeWorkspace('c2', sampleWorkspace());
    const viewKey = messageListViewKey('c1', 'thread-1');
    rememberMessageListScrollPosition(viewKey, 100);

    deleteWorkspace('c1');

    expect(readWorkspace('c1')).toBeNull();
    expect(readPersistedCanvasIndex()).toEqual(['c2']);
    expect(
      restoreMessageListScrollPosition(document.createElement('div'), viewKey),
    ).toBe(false);
  });

  it('survives a corrupt index', () => {
    testStorage.storage.setItem('huabu.previewWorkspace.index', '{oops');
    writeWorkspace('c1', sampleWorkspace());
    expect(readPersistedCanvasIndex()).toEqual(['c1']);
  });
});

describe('unavailable storage', () => {
  it('reads as missing and writes without throwing', () => {
    const original = Object.getOwnPropertyDescriptor(
      globalThis,
      'localStorage',
    );
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage disabled');
      },
    });

    try {
      expect(readWorkspace(CANVAS)).toBeNull();
      expect(() => writeWorkspace(CANVAS, sampleWorkspace())).not.toThrow();
      expect(() => deleteWorkspace(CANVAS)).not.toThrow();
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
    }
  });
});

describe('seedWorkspaceFromLegacyChat', () => {
  it('seeds the unbound canvas chat as the base tab', () => {
    const ws = seedWorkspaceFromLegacyChat(
      CANVAS,
      { chatThreadId: 'thread-1' },
      { groupId: 'g1', chatTabId: 'chat' },
    );

    expect(ws?.groups[0].tabIds).toEqual(['chat']);
    expect(ws?.tabs['chat'].target).toEqual({
      kind: 'chat',
      canvasId: CANVAS,
      threadId: 'thread-1',
    });
    expect(ws?.groups[0].activeTabId).toBe('chat');
  });

  it('adds an open question replay as the active tab', () => {
    const ws = seedWorkspaceFromLegacyChat(
      CANVAS,
      { chatThreadId: 'thread-1', questionNodeId: 'q1' },
      { groupId: 'g1', chatTabId: 'chat', nodeTabId: 'question' },
    );

    expect(ws?.groups[0].tabIds).toEqual(['chat', 'question']);
    expect(ws?.groups[0].activeTabId).toBe('question');
  });

  it('returns null when there is no legacy chat state to carry over', () => {
    expect(seedWorkspaceFromLegacyChat(CANVAS, {})).toBeNull();
    expect(seedWorkspaceFromLegacyChat('', { chatThreadId: 't' })).toBeNull();
  });

  it('round-trips through storage', () => {
    const seeded = seedWorkspaceFromLegacyChat(CANVAS, {
      chatThreadId: 'thread-1',
    });
    expect(seeded).not.toBeNull();
    if (!seeded) return;
    writeWorkspace(CANVAS, seeded);

    expect(readWorkspace(CANVAS)).toEqual(seeded);
  });
});
