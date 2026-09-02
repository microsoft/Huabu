// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatSessionProvider } from '@/hooks/useChatSession';
import { selectThreadDraft, useChatStore } from '@/store/chatStore';

import { ThreadChatInput } from './ThreadChatInput';

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
