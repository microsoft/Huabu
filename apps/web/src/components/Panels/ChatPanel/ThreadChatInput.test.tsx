// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatSessionProvider } from '@/hooks/useChatSession';
import { selectThreadDraft, useChatStore } from '@/store/chatStore';

import { ThreadChatInput } from './ThreadChatInput';

import type { ChatAttachment } from '@huabu/shared';
import type * as ReactI18next from 'react-i18next';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactI18next>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/Nodes/NodeRef/NodeRef', () => ({
  NodeRef: ({
    nodeId,
    attachment,
    strokeCount,
  }: {
    nodeId?: string;
    attachment?: ChatAttachment;
    strokeCount?: number;
  }) => (
    <span data-node-ref={nodeId} data-stroke-count={strokeCount}>
      {attachment?.label ?? nodeId}
    </span>
  ),
}));

vi.mock('./ChatInput', () => ({
  ChatInput: ({
    value,
    onChange,
    onSubmit,
  }: {
    value: string;
    onChange: (value: string) => void;
    onSubmit: (event: React.FormEvent, mode: 'ask') => void;
  }) => (
    <form onSubmit={(event) => onSubmit(event, 'ask')}>
      <textarea
        aria-label="Thread draft"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <button type="submit">Send</button>
    </form>
  ),
}));

let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeEach(() => {
  useChatStore.setState({ threadsById: {} });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
});

describe('ThreadChatInput', () => {
  it('renders queued snapshots as user messages with their full context without a reload warning', () => {
    const session = {
      threadId: 'thread-test',
      canvasId: 'canvas-test',
      ownerCanvasId: 'canvas-test',
      conversationView: null,
    };
    const chat = useChatStore.getState();
    chat.enqueueTurn(session.threadId, {
      id: 'queued-1',
      status: 'pending',
      prepared: {
        session,
        inputKind: 'text',
        content: 'Full queued request\nWith a second line',
        mode: 'operate',
        agentBinding: { kind: 'internal' },
        settings: { modelId: null, reasoningEffort: null },
        invokedSkills: ['review'],
        quotedComments: [
          {
            quote: 'Original passage',
            comment: 'Explain this',
            contextBefore: '',
            contextAfter: '',
          },
        ],
        attachments: [
          {
            type: 'image',
            source: 'upload',
            url: '/image.png',
            label: 'Attached image',
          },
        ],
        sources: {
          canvasId: session.canvasId,
          canvasContext: {
            selectedNodes: [
              {
                id: 'sketch-1',
                type: 'sketch',
                strokeIds: ['stroke-1', 'stroke-2'],
              },
            ],
          },
        },
      },
    });
    const onCommit = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        <ChatSessionProvider value={session}>
          <ThreadChatInput
            onSubmit={vi.fn()}
            onStop={vi.fn()}
            onCommit={onCommit}
            mode="operate"
          >
            <div data-change-review>Changes</div>
          </ThreadChatInput>
        </ChatSessionProvider>,
      ),
    );
    const message = container.querySelector('[data-chat-user-message]');
    expect(
      message?.querySelector('[data-chat-prompt-content]')?.textContent,
    ).toBe('Full queued request\nWith a second line');
    expect(message?.querySelector('blockquote')?.textContent).toBe(
      'Original passage',
    );
    expect(message?.textContent).toContain('Explain this');
    expect(message?.textContent).toContain('/review');
    expect(message?.textContent).toContain('Attached image');
    expect(
      message
        ?.querySelector('[data-node-ref="sketch-1"]')
        ?.getAttribute('data-stroke-count'),
    ).toBe('2');
    expect(container.textContent).not.toContain('chat.queueMemoryOnly');
    const queue = container.querySelector('section');
    const changes = container.querySelector('[data-change-review]');
    const input = container.querySelector('form');
    expect(queue?.nextElementSibling).toBe(changes);
    expect(changes?.nextElementSibling).toBe(input);
    expect(
      useChatStore.getState().threadsById[session.threadId].messages,
    ).toEqual([]);
    act(() =>
      container
        ?.querySelector<HTMLButtonElement>(
          '[aria-label="chat.removeFromQueue"]',
        )
        ?.click(),
    );
    expect(onCommit).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-chat-user-message]')).toBeNull();
    expect(container.querySelector('section')).toBeNull();
    expect(container.firstElementChild).toBe(changes);
    expect(changes?.nextElementSibling).toBe(input);
  });

  it('updates its thread draft without rerendering its parent', () => {
    let parentRenderCount = 0;
    const onSubmit = vi.fn();

    function Parent() {
      parentRenderCount++;
      return (
        <ThreadChatInput onSubmit={onSubmit} onStop={vi.fn()} mode="ask" />
      );
    }

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        <ChatSessionProvider
          value={{
            threadId: 'thread-test',
            canvasId: 'canvas-test',
            ownerCanvasId: 'canvas-test',
            conversationView: null,
          }}
        >
          <Parent />
        </ChatSessionProvider>,
      ),
    );

    const textarea = container.querySelector('textarea');
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      valueSetter?.call(textarea, 'thread-local draft');
      textarea?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(parentRenderCount).toBe(1);
    expect(selectThreadDraft(useChatStore.getState(), 'thread-test')).toBe(
      'thread-local draft',
    );
    expect(textarea?.value).toBe('thread-local draft');

    act(() => {
      container
        ?.querySelector('form')
        ?.dispatchEvent(new SubmitEvent('submit', { bubbles: true }));
    });
    expect(onSubmit).toHaveBeenCalledWith(
      expect.anything(),
      'ask',
      'thread-local draft',
    );
  });
});
