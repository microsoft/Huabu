// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useMemo } from 'react';

import { MessageList } from '@/components/Messages/MessageList';
import { ThreadChatInput } from '@/components/Panels/ChatPanel/ThreadChatInput';
import { ChatSessionProvider } from '@/hooks/useChatSession';

import type { ChatMessage } from '@/store/chatTypes';

const SESSION = {
  threadId: 'chat-performance-thread',
  canvasId: 'chat-performance-canvas',
  ownerCanvasId: 'chat-performance-canvas',
  conversationView: null,
} as const;

function buildMessages(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, index): ChatMessage => {
    if (index % 2 === 0) {
      return {
        id: `user-${index}`,
        role: 'user',
        content: `Representative question ${index / 2 + 1}`,
      };
    }
    return {
      id: `assistant-${index}`,
      role: 'assistant',
      segments: [
        {
          kind: 'text',
          text: `## Representative answer ${(index + 1) / 2}\n\nThis fixture includes **Markdown**, a [link](https://example.com), and enough text to exercise the real historical message renderer.`,
        },
      ],
    };
  });
}

export default function ChatPerformancePlaygroundPage() {
  const params = new URLSearchParams(window.location.search);
  const messageCount = Math.max(
    0,
    Number.parseInt(params.get('messages') ?? '0', 10) || 0,
  );
  const visibleMessageCount = Math.max(
    0,
    Number.parseInt(
      params.get('visibleMessages') ?? String(messageCount),
      10,
    ) || 0,
  );
  const messages = useMemo(
    () =>
      visibleMessageCount === 0
        ? []
        : buildMessages(messageCount).slice(-visibleMessageCount),
    [messageCount, visibleMessageCount],
  );

  return (
    <ChatSessionProvider value={SESSION}>
      <main
        data-chat-performance-fixture={messageCount}
        data-chat-visible-messages={messages.length}
        className="bg-bg-default mx-auto flex h-full w-full max-w-3xl flex-col p-4"
      >
        <MessageList messages={messages} isLoading={false} />
        <div className="pt-3">
          <ThreadChatInput
            onSubmit={() => undefined}
            onStop={() => undefined}
            mode="ask"
          />
        </div>
      </main>
    </ChatSessionProvider>
  );
}
