// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { queryConversationTitles } from '@/api/conversationTitles';
import {
  conversationTitleKey,
  getConversationTitle,
  refreshConversationTitles,
  useConversationTitleStore,
} from '@/store/conversationTitleStore';

import {
  handleStreamEvent,
  registerAcpSessionMetaSink,
} from './useAgentStream';

import type {
  AgentStreamEvent,
  QueryConversationTitlesResponse,
} from '@huabu/shared';

vi.mock('@/api/conversationTitles', () => ({
  queryConversationTitles: vi.fn(),
  setConversationTitle: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(queryConversationTitles).mockReset();
  useConversationTitleStore.setState({
    entries: {},
    pending: {},
    refreshEpoch: 0,
  });
});

const modeUpdate = {
  type: 'session_mode_update',
  data: { currentModeId: 'operate' },
} as AgentStreamEvent;

describe('ACP session metadata routing', () => {
  it('invalidates only the owning canvas title and never displays raw ACP metadata while awaiting the backend', async () => {
    const value = { title: 'Backend title', source: 'generated' as const };
    useConversationTitleStore.setState({
      entries: Object.fromEntries(
        ['canvas-1', 'canvas-2'].map((canvasId) => [
          conversationTitleKey(canvasId, 'thread-1'),
          { value, revision: 0, durable: true },
        ]),
      ),
    });
    let resolve!: (value: QueryConversationTitlesResponse) => void;
    const response = new Promise<QueryConversationTitlesResponse>((done) => {
      resolve = done;
    });
    vi.mocked(queryConversationTitles).mockReturnValue(response);
    try {
      handleStreamEvent(
        { type: 'session_info_update', data: { title: 'Raw ACP title' } },
        {
          threadId: 'thread-1',
          assistantId: 'assistant-1',
          titleCanvasId: 'canvas-1',
        },
      );
      expect(getConversationTitle('canvas-1', 'thread-1')).toEqual(value);
      expect(getConversationTitle('canvas-2', 'thread-1')).toEqual(value);
      expect(queryConversationTitles).toHaveBeenCalledExactlyOnceWith({
        canvasId: 'canvas-1',
        threadIds: ['thread-1'],
      });
      resolve({
        titles: {
          'thread-1': { title: 'Server-selected fallback', source: 'fallback' },
        },
      });
      await refreshConversationTitles('canvas-1', ['thread-1']);
      expect(getConversationTitle('canvas-1', 'thread-1')).toEqual({
        title: 'Server-selected fallback',
        source: 'fallback',
      });
      expect(getConversationTitle('canvas-2', 'thread-1')).toEqual(value);
    } finally {
      resolve({ titles: {} });
      await response;
    }
  });

  it('does not read or adopt conversation titles for a Question stream without a title scope', () => {
    handleStreamEvent(
      { type: 'session_info_update', data: { title: 'Raw Question title' } },
      {
        threadId: 'thread-1',
        assistantId: 'assistant-1',
      },
    );
    expect(queryConversationTitles).not.toHaveBeenCalled();
    expect(useConversationTitleStore.getState().entries).toEqual({});
  });

  it('dispatches updates only to the sink registered for the owning thread', () => {
    const firstSink = vi.fn();
    const secondSink = vi.fn();
    const unregisterFirst = registerAcpSessionMetaSink('thread-1', firstSink);
    const unregisterSecond = registerAcpSessionMetaSink('thread-2', secondSink);

    handleStreamEvent(modeUpdate, {
      threadId: 'thread-1',
      assistantId: 'assistant-1',
    });

    expect(firstSink).toHaveBeenCalledOnce();
    expect(firstSink).toHaveBeenCalledWith(modeUpdate);
    expect(secondSink).not.toHaveBeenCalled();

    unregisterFirst();
    unregisterSecond();
  });

  it('unregisters one thread without disturbing another', () => {
    const firstSink = vi.fn();
    const secondSink = vi.fn();
    const unregisterFirst = registerAcpSessionMetaSink('thread-1', firstSink);
    const unregisterSecond = registerAcpSessionMetaSink('thread-2', secondSink);

    unregisterFirst();
    handleStreamEvent(modeUpdate, {
      threadId: 'thread-2',
      assistantId: 'assistant-2',
    });

    expect(firstSink).not.toHaveBeenCalled();
    expect(secondSink).toHaveBeenCalledOnce();

    unregisterSecond();
  });

  it('does not let stale cleanup remove a replacement sink', () => {
    const staleSink = vi.fn();
    const currentSink = vi.fn();
    const unregisterStale = registerAcpSessionMetaSink('thread-1', staleSink);
    const unregisterCurrent = registerAcpSessionMetaSink(
      'thread-1',
      currentSink,
    );

    unregisterStale();
    handleStreamEvent(modeUpdate, {
      threadId: 'thread-1',
      assistantId: 'assistant-1',
    });

    expect(staleSink).not.toHaveBeenCalled();
    expect(currentSink).toHaveBeenCalledOnce();

    unregisterCurrent();
  });
});
