// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { agentApi } from '@/api/agent';
import { useChatStore } from '@/store/chatStore';
import { useWorkspaceStore } from '@/store/workspaceStore';

import { loadHistoryToolDetails } from './useHistoryToolDetails';

import type { ChatMessage } from '@/store/chatTypes';
import type {
  AssistantToolPart,
  AgentHistoryTurnResponse,
} from '@huabu/shared';

const summary: AssistantToolPart = {
  kind: 'tool',
  variant: 'generic',
  toolCallId: 'read',
  title: 'Read',
  detail: { state: 'deferred', turnRef: 'ref', summary: {} },
};
const full: AssistantToolPart = {
  ...summary,
  detail: { state: 'inline', turnRef: 'ref' },
  content: [
    { type: 'content', content: { type: 'text', text: 'Complete body' } },
  ],
};
const message: ChatMessage = {
  id: 'message',
  role: 'assistant',
  historyTurnId: 'group',
  segments: [summary],
};
const response: AgentHistoryTurnResponse = {
  threadId: 'thread',
  turnRef: 'ref',
  messages: [{ role: 'assistant', parts: [full] }],
};

function request() {
  let resolve!: (value: AgentHistoryTurnResponse) => void;
  const fetch = vi.spyOn(agentApi, 'fetchHistoryTurn').mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  return { fetch, resolve };
}
const messages = () => useChatStore.getState().threadsById.thread?.messages;

describe('physical-turn detail loading', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useChatStore.setState({ threadsById: {}, threadMap: {} });
    useWorkspaceStore.setState({ workspaceId: 'workspace' });
    useChatStore.getState().setMessages('thread', [message]);
    useChatStore.getState().setHistoryLoaded('thread', true);
  });

  it('deduplicates requests and retains permission and text segments added while loading', async () => {
    const { fetch, resolve } = request();
    const first = loadHistoryToolDetails('canvas', 'thread', 'ref');
    expect(loadHistoryToolDetails('canvas', 'thread', 'ref')).toBe(first);
    const permission = {
      kind: 'permission' as const,
      requestId: 'permission',
      toolCall: { toolCallId: 'pending', title: 'Permission' },
      options: [],
    };
    useChatStore.getState().setMessages('thread', [
      {
        ...message,
        segments: [summary, { kind: 'text', text: 'Visible text' }, permission],
      },
    ]);
    resolve(response);
    await first;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(messages()).toEqual([
      {
        ...message,
        segments: [full, { kind: 'text', text: 'Visible text' }, permission],
      },
    ]);
  });

  it.each(['workspace', 'revision'] as const)(
    'rejects obsolete %s responses',
    async (scope) => {
      const { resolve } = request();
      const loading = loadHistoryToolDetails('canvas', 'thread', 'ref');
      if (scope === 'workspace')
        useWorkspaceStore.setState({ workspaceId: 'another-workspace' });
      else useChatStore.getState().setHistoryLoaded('thread', false);
      resolve(response);
      await expect(loading).rejects.toThrow('obsolete');
      expect(messages()).toEqual([message]);
    },
  );

  it.each(['evicted', 'active', 'replaced'] as const)(
    'does not restore or overwrite %s messages',
    async (state) => {
      const { resolve } = request();
      const loading = loadHistoryToolDetails('canvas', 'thread', 'ref');
      const next: ChatMessage[] =
        state === 'evicted'
          ? []
          : [
              {
                ...message,
                ...(state === 'active'
                  ? { historyTurnActive: true }
                  : {
                      segments: [
                        {
                          ...summary,
                          detail: {
                            state: 'deferred',
                            turnRef: 'replacement',
                            summary: {},
                          },
                        },
                      ],
                    }),
              },
            ];
      useChatStore.getState().setMessages('thread', next);
      resolve(response);
      await loading;
      expect(messages()).toEqual(next);
    },
  );

  it.each(['thread', 'reference', 'body'] as const)(
    'rejects a mismatched %s and permits retry',
    async (mismatch) => {
      const { resolve, fetch } = request();
      const loading = loadHistoryToolDetails('canvas', 'thread', 'ref');
      resolve({
        ...response,
        ...(mismatch === 'thread'
          ? { threadId: 'other' }
          : mismatch === 'reference'
            ? { turnRef: 'other' }
            : { messages: [] }),
      });
      await expect(loading).rejects.toThrow(/identity mismatch|incomplete/);
      expect(messages()).toEqual([message]);
      fetch.mockResolvedValue(response);
      await loadHistoryToolDetails('canvas', 'thread', 'ref');
      expect(messages()).toEqual([{ ...message, segments: [full] }]);
    },
  );
});
