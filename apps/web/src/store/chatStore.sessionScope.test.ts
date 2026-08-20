// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it } from 'vitest';

import {
  selectThreadBinding,
  selectThreadDraft,
  selectThreadHistoryLoaded,
  selectThreadIsLoading,
  selectThreadLastAction,
  selectThreadMessages,
  selectThreadPendingAttachments,
  selectThreadSettings,
  useChatStore,
} from './chatStore';

import type { ChatMessage } from './chatTypes';
import type { AgentBinding, ChatAttachment } from '@huabu/shared';

const INTERNAL: AgentBinding = { kind: 'internal' };
const EXTERNAL: AgentBinding = {
  kind: 'external',
  alias: 'Claude Code',
  profileId: 'profile-1',
};
const ATTACHMENT: ChatAttachment = {
  type: 'text',
  source: 'upload',
  content: 'staged',
  label: 'x',
};

function resetStore() {
  useChatStore.setState({
    threadsById: {},
    lastActionByThread: {},
    bindingByThread: {},
    settingsByThread: {},
    ephemeralMetadataThreads: {},
    ephemeralSettingsThreads: {},
    threadMap: {},
    bindingMap: {},
    selectionAttachment: null,
  });
}

function userMessage(id: string, content: string): ChatMessage {
  return { id, role: 'user', content };
}

beforeEach(resetStore);

describe('chatStore thread-scoped state', () => {
  it('isolates messages, loading, drafts, settings and attachments', () => {
    const store = useChatStore.getState();
    store.addMessage('thread-a', userMessage('m1', 'hello a'));
    store.addMessage('thread-b', userMessage('m2', 'hello b'));
    store.setHistoryLoaded('thread-a', true);
    store.setThreadLoading('thread-b', true);
    store.setDraft('thread-a', 'draft a');
    store.setThreadSettings('thread-a', {
      modelId: 'model-a',
      reasoningEffort: 'high',
    });
    store.addPendingAttachment('thread-a', ATTACHMENT);

    const state = useChatStore.getState();
    expect(selectThreadMessages(state, 'thread-a')).toHaveLength(1);
    expect(selectThreadMessages(state, 'thread-b')).toHaveLength(1);
    expect(selectThreadHistoryLoaded(state, 'thread-a')).toBe(true);
    expect(selectThreadIsLoading(state, 'thread-a')).toBe(false);
    expect(selectThreadIsLoading(state, 'thread-b')).toBe(true);
    expect(selectThreadDraft(state, 'thread-a')).toBe('draft a');
    expect(selectThreadDraft(state, 'thread-b')).toBe('');
    expect(selectThreadSettings(state, 'thread-a')).toEqual({
      modelId: 'model-a',
      reasoningEffort: 'high',
    });
    expect(selectThreadSettings(state, 'thread-b')).toEqual({
      modelId: null,
      reasoningEffort: null,
    });
    expect(selectThreadPendingAttachments(state, 'thread-a')).toEqual([
      ATTACHMENT,
    ]);
    expect(selectThreadPendingAttachments(state, 'thread-b')).toEqual([]);
  });

  it('keeps binding and compose mode with their thread', () => {
    const store = useChatStore.getState();
    store.setAgentBinding('thread-a', EXTERNAL);
    store.setThreadLastAction('thread-a', 'operate');

    const state = useChatStore.getState();
    expect(selectThreadBinding(state, 'thread-a')).toEqual(EXTERNAL);
    expect(selectThreadBinding(state, 'thread-b')).toEqual(INTERNAL);
    expect(selectThreadLastAction(state, 'thread-a')).toBe('operate');
    expect(selectThreadLastAction(state, 'thread-b')).toBe('operate');
  });

  it('defaults an uncached external thread to ask', () => {
    useChatStore.setState({
      bindingByThread: { 'thread-external': EXTERNAL },
    });

    expect(
      selectThreadLastAction(useChatStore.getState(), 'thread-external'),
    ).toBe('ask');
  });

  it('returns stable defaults for an uncached thread', () => {
    const state = useChatStore.getState();
    const first = selectThreadMessages(state, 'missing');
    const second = selectThreadMessages(state, 'missing');
    expect(first).toBe(second);
    expect(first).toEqual([]);
  });
});

describe('chatStore thread creation', () => {
  it('creates and reuses one canonical chat thread per Canvas', () => {
    const store = useChatStore.getState();
    const first = store.ensureCanvasThread('canvas-1');
    const again = store.ensureCanvasThread('canvas-1');
    const second = store.ensureCanvasThread('canvas-2');

    expect(again).toBe(first);
    expect(second).not.toBe(first);
    expect(useChatStore.getState().threadMap).toEqual({
      'canvas-1': first,
      'canvas-2': second,
    });
    expect(selectThreadBinding(useChatStore.getState(), first)).toEqual(
      INTERNAL,
    );
    expect(selectThreadLastAction(useChatStore.getState(), first)).toBe(
      'operate',
    );
  });

  it('defaults a new independent thread to the built-in Huabu Agent', () => {
    const created = useChatStore.getState().createThread();
    const state = useChatStore.getState();

    expect(selectThreadBinding(state, created)).toEqual(INTERNAL);
    expect(selectThreadLastAction(state, created)).toBe('operate');
  });

  it('defaults external Canvas and independent threads to ask', () => {
    useChatStore.setState({
      bindingMap: { 'canvas-external': EXTERNAL },
    });

    const canvasThread = useChatStore
      .getState()
      .ensureCanvasThread('canvas-external');
    const independentThread = useChatStore
      .getState()
      .createThread({ binding: EXTERNAL });

    const state = useChatStore.getState();
    expect(selectThreadLastAction(state, canvasThread)).toBe('ask');
    expect(selectThreadLastAction(state, independentThread)).toBe('ask');
  });

  it('creates a loaded thread without moving another renderer', () => {
    const store = useChatStore.getState();
    store.setMessages('thread-initial', [userMessage('old', 'keep')]);
    const created = store.createThread({
      binding: EXTERNAL,
      lastAction: 'operate',
    });

    const state = useChatStore.getState();
    expect(selectThreadMessages(state, 'thread-initial')).toHaveLength(1);
    expect(selectThreadMessages(state, created)).toEqual([]);
    expect(selectThreadHistoryLoaded(state, created)).toBe(true);
    expect(selectThreadBinding(state, created)).toEqual(EXTERNAL);
    expect(selectThreadLastAction(state, created)).toBe('operate');
  });
});

describe('chatStore persistence and eviction', () => {
  it('keeps authoritative Question metadata in memory only', () => {
    const store = useChatStore.getState();
    store.setAgentBinding('thread-question', EXTERNAL);
    store.setThreadLastAction('thread-question', 'operate');
    store.setThreadSettings('thread-question', {
      modelId: 'model-1',
      reasoningEffort: 'high',
    });

    store.makeThreadMetadataEphemeral('thread-question');
    store.setThreadLastAction('thread-question', 'ask');

    const state = useChatStore.getState();
    expect(selectThreadBinding(state, 'thread-question')).toEqual(EXTERNAL);
    expect(selectThreadLastAction(state, 'thread-question')).toBe('ask');
    expect(selectThreadSettings(state, 'thread-question')).toEqual({
      modelId: 'model-1',
      reasoningEffort: 'high',
    });
    expect(state.bindingByThread['thread-question']).toBeUndefined();
    expect(state.lastActionByThread['thread-question']).toBeUndefined();
    expect(state.settingsByThread['thread-question']).toBeUndefined();
  });

  it('keeps first-send settings durable until the server thread responds', () => {
    const store = useChatStore.getState();
    store.setAgentBinding('thread-question', EXTERNAL);
    store.setThreadLastAction('thread-question', 'operate');
    store.setThreadSettings('thread-question', {
      modelId: 'model-1',
      reasoningEffort: 'high',
    });

    store.makeThreadMetadataEphemeral('thread-question', {
      preserveSettings: true,
    });

    let state = useChatStore.getState();
    expect(state.bindingByThread['thread-question']).toBeUndefined();
    expect(state.lastActionByThread['thread-question']).toBeUndefined();
    expect(state.settingsByThread['thread-question']).toEqual({
      modelId: 'model-1',
      reasoningEffort: 'high',
    });

    store.setThreadSettings('thread-question', {
      modelId: 'model-2',
      reasoningEffort: 'medium',
    });
    state = useChatStore.getState();
    expect(state.settingsByThread['thread-question']).toEqual({
      modelId: 'model-2',
      reasoningEffort: 'medium',
    });

    store.makeThreadMetadataEphemeral('thread-question');
    store.setThreadSettings('thread-question', {
      modelId: 'model-3',
      reasoningEffort: 'low',
    });

    state = useChatStore.getState();
    expect(state.settingsByThread['thread-question']).toBeUndefined();
  });

  it('restores independent thread binding and settings after reload', () => {
    useChatStore.setState({
      threadsById: {},
      bindingByThread: { 'thread-secondary': EXTERNAL },
      settingsByThread: {
        'thread-secondary': {
          modelId: 'model-1',
          reasoningEffort: 'high',
        },
      },
    });

    const state = useChatStore.getState();
    expect(selectThreadBinding(state, 'thread-secondary')).toEqual(EXTERNAL);
    expect(selectThreadSettings(state, 'thread-secondary')).toEqual({
      modelId: 'model-1',
      reasoningEffort: 'high',
    });

    const partialize = useChatStore.persist.getOptions().partialize;
    const persisted = partialize?.(state) as Partial<typeof state>;
    expect(persisted.bindingByThread?.['thread-secondary']).toEqual(EXTERNAL);
    expect(persisted.settingsByThread?.['thread-secondary']).toEqual({
      modelId: 'model-1',
      reasoningEffort: 'high',
    });
  });

  it('retains metadata for more than 50 independent threads', () => {
    const store = useChatStore.getState();
    for (let index = 0; index <= 50; index += 1) {
      const threadId = `thread-${index}`;
      store.setAgentBinding(threadId, EXTERNAL);
      store.setThreadSettings(threadId, {
        modelId: `model-${index}`,
        reasoningEffort: 'high',
      });
      store.setThreadLastAction(threadId, 'operate');
    }

    useChatStore.setState({ threadsById: {} });
    const state = useChatStore.getState();
    expect(selectThreadBinding(state, 'thread-0')).toEqual(EXTERNAL);
    expect(selectThreadSettings(state, 'thread-0')).toEqual({
      modelId: 'model-0',
      reasoningEffort: 'high',
    });
    expect(selectThreadLastAction(state, 'thread-0')).toBe('operate');
    expect(Object.keys(state.bindingByThread)).toHaveLength(51);
    expect(Object.keys(state.settingsByThread)).toHaveLength(51);
    expect(Object.keys(state.lastActionByThread)).toHaveLength(51);
  });

  it('migrates the legacy global compose mode', async () => {
    const migrate = useChatStore.persist.getOptions().migrate;
    const migrated = (await migrate?.(
      { threadId: 'thread-legacy', lastAction: 'operate' },
      2,
    )) as Partial<ReturnType<typeof useChatStore.getState>>;
    expect(migrated.lastActionByThread).toEqual({
      'thread-legacy': 'operate',
    });
  });

  it('migrates a v4 Canvas binding to its canonical thread', async () => {
    const migrate = useChatStore.persist.getOptions().migrate;
    const migrated = (await migrate?.(
      {
        threadMap: { 'canvas-1': 'thread-canonical' },
        bindingMap: { 'canvas-1': EXTERNAL },
      },
      4,
    )) as Partial<ReturnType<typeof useChatStore.getState>>;

    expect(migrated.bindingByThread).toEqual({
      'thread-canonical': EXTERNAL,
    });
  });

  it('pins current, mapped and streaming threads', () => {
    const store = useChatStore.getState();
    for (const threadId of ['t1', 't2', 't3', 't4']) {
      store.addMessage(threadId, userMessage(`m-${threadId}`, threadId));
    }
    useChatStore.setState({
      threadMap: { 'canvas-1': 't1', 'canvas-2': 't3' },
    });
    store.setThreadLoading('t2', true);
    store.evictInactiveThreads(1);

    const state = useChatStore.getState();
    expect(Object.keys(state.threadsById).sort()).toEqual(['t1', 't2', 't3']);
    expect(selectThreadMessages(state, 't4')).toEqual([]);
  });
});
