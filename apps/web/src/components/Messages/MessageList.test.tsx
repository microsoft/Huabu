// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageList } from './MessageList';

import type { ChatMessage } from '../../store/chatTypes';

const renderCounts = vi.hoisted(() => ({
  assistant: new Map<string, number>(),
  user: 0,
}));

vi.mock('./AIMessage', async () => {
  const { memo } = await import('react');
  return {
    AIMessage: memo(function MockAIMessage({
      messageId,
    }: {
      messageId: string;
    }) {
      renderCounts.assistant.set(
        messageId,
        (renderCounts.assistant.get(messageId) ?? 0) + 1,
      );
      return <div data-assistant-message={messageId} />;
    }),
  };
});

vi.mock('./UserMessage', async () => {
  const { memo } = await import('react');
  return {
    UserMessage: memo(function MockUserMessage() {
      renderCounts.user++;
      return <div data-user-message />;
    }),
  };
});

vi.mock('./StatusMessage', () => ({
  StatusMessage: () => <div data-status-message />,
}));

vi.mock('../Common/Button', () => ({
  Button: ({ children }: { children: React.ReactNode }) => (
    <button>{children}</button>
  ),
}));

vi.mock('../Common/Loading', () => ({
  Loading: () => <div data-loading />,
}));

vi.mock('../Common/ThinkingIndicator', () => ({
  ThinkingIndicator: () => <div data-thinking />,
}));

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function mount(element: React.ReactNode): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
}

beforeEach(() => {
  renderCounts.assistant.clear();
  renderCounts.user = 0;
  vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(() => {});
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
});

describe('MessageList render isolation', () => {
  it('does not rerender historical messages when a sibling draft changes', () => {
    const messages: ChatMessage[] = Array.from(
      { length: 100 },
      (_, index): ChatMessage[] => [
        {
          id: `user-${index}`,
          role: 'user',
          content: `Question ${index}`,
        },
        {
          id: `assistant-${index}`,
          role: 'assistant',
          segments: [
            {
              kind: 'text',
              text: `## Answer ${index}\n\nA representative Markdown response.`,
            },
          ],
        },
      ],
    ).flat();

    function Harness() {
      const [draft, setDraft] = useState('');
      return (
        <>
          <textarea
            aria-label="Draft"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <MessageList messages={messages} isLoading={false} />
        </>
      );
    }

    mount(<Harness />);
    const textarea = container?.querySelector('textarea');
    expect(textarea).not.toBeNull();

    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      valueSetter?.call(textarea, '你');
      textarea?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(renderCounts.user).toBe(100);
    expect(renderCounts.assistant.size).toBe(100);
    expect(
      [...renderCounts.assistant.values()].every((count) => count === 1),
    ).toBe(true);
  });

  it('rerenders only the assistant message whose segments changed', () => {
    const first = {
      id: 'assistant-1',
      role: 'assistant',
      segments: [{ kind: 'text', text: 'Stable' }],
    } satisfies ChatMessage;
    const second = {
      id: 'assistant-2',
      role: 'assistant',
      segments: [{ kind: 'text', text: 'Streaming' }],
    } satisfies ChatMessage;

    mount(<MessageList messages={[first, second]} isLoading />);
    act(() => {
      root?.render(
        <MessageList
          messages={[
            first,
            {
              ...second,
              segments: [{ kind: 'text', text: 'Streaming update' }],
            },
          ]}
          isLoading
        />,
      );
    });

    expect(renderCounts.assistant.get('assistant-1')).toBe(1);
    expect(renderCounts.assistant.get('assistant-2')).toBe(2);
  });
});
