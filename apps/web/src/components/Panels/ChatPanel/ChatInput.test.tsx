// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatSessionProvider } from '@/hooks/useChatSession';

import { ChatInput } from './ChatInput';

import type { ChatAttachment } from '@huabu/shared';

const chatState = {
  pendingAttachments: [] as ChatAttachment[],
  selectionAttachment: null,
  addPendingAttachment: vi.fn(),
  removePendingAttachment: vi.fn(),
};

const panelState: {
  focusChatInputRequest: { threadId: string; nonce: number } | null;
} = {
  focusChatInputRequest: null,
};

vi.mock('@/store/chatStore', () => {
  const useChatStore = Object.assign(
    (selector: (state: typeof chatState) => unknown) => selector(chatState),
    { getState: () => chatState },
  );
  return {
    selectThreadMessages: () => [],
    selectThreadPendingAttachments: () => chatState.pendingAttachments,
    useChatStore,
  };
});

vi.mock('@/store/panelStore', () => ({
  usePanelStore: (selector: (state: typeof panelState) => unknown) =>
    selector(panelState),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('./ContextUsageRing', () => ({ ContextUsageRing: () => null }));
vi.mock('./ChatContextSources', () => ({
  ChatContextSources: ({
    adjacentNodeSourceId,
  }: {
    adjacentNodeSourceId?: string;
  }) => (
    <div data-chat-context-sources data-adjacent-node={adjacentNodeSourceId} />
  ),
}));
vi.mock('./SlashCommandMenu', () => ({ SlashCommandMenu: () => null }));
vi.mock('./useSlashCommandTypeahead', () => ({
  useSlashCommandTypeahead: () => ({
    slashState: null,
    slashMenuRef: { current: null },
    syncCaret: vi.fn(),
    acceptSlashCommand: vi.fn(),
    handleKeyDown: () => false,
  }),
}));

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  panelState.focusChatInputRequest = null;
  chatState.pendingAttachments = [];
  chatState.addPendingAttachment.mockClear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ChatInput', () => {
  it('focuses a requested composer without scrolling its layout ancestors', () => {
    panelState.focusChatInputRequest = { threadId: 'thread-test', nonce: 1 };
    const focus = vi.spyOn(HTMLTextAreaElement.prototype, 'focus');
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });

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
          <ChatInput
            value=""
            onChange={vi.fn()}
            onSubmit={vi.fn()}
            onStop={vi.fn()}
            mode="ask"
          />
        </ChatSessionProvider>,
      ),
    );

    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('stops a running turn without submitting the preserved draft', () => {
    const onStop = vi.fn();
    const onSubmit = vi.fn();

    function Harness() {
      const [value, setValue] = useState('Keep this draft');
      const [isStreaming, setIsStreaming] = useState(true);

      return (
        <ChatInput
          value={value}
          onChange={setValue}
          onSubmit={onSubmit}
          onStop={() => {
            onStop();
            setIsStreaming(false);
          }}
          isStreaming={isStreaming}
          mode="ask"
        />
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
          <Harness />
        </ChatSessionProvider>,
      ),
    );

    const stopButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="chat.stop"]',
    );
    expect(stopButton).not.toBeNull();

    act(() => {
      stopButton?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });

    expect(onStop).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(container.querySelector('textarea')?.value).toBe('Keep this draft');
  });

  it('places the unified source display before the textarea, not beside Send', () => {
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
          <ChatInput
            value=""
            onChange={vi.fn()}
            onSubmit={vi.fn()}
            onStop={vi.fn()}
            mode="ask"
            adjacentNodeSourceId="node-adjacent"
          />
        </ChatSessionProvider>,
      ),
    );

    const sources = container.querySelector('[data-chat-context-sources]');
    const textarea = container.querySelector('textarea');
    expect(sources?.getAttribute('data-adjacent-node')).toBe('node-adjacent');
    expect(
      sources?.parentElement?.hasAttribute('data-chat-input-surface'),
    ).toBe(true);
    expect(sources?.nextElementSibling?.contains(textarea)).toBe(true);
    expect(
      container.querySelectorAll('[data-chat-context-sources]'),
    ).toHaveLength(1);
  });

  it('updates a Chinese IME composition without submitting it', () => {
    const onSubmit = vi.fn();

    function Harness() {
      const [value, setValue] = useState('');
      return (
        <ChatInput
          value={value}
          onChange={setValue}
          onSubmit={onSubmit}
          onStop={vi.fn()}
          mode="ask"
        />
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
          <Harness />
        </ChatSessionProvider>,
      ),
    );

    const textarea = container.querySelector('textarea');
    expect(textarea).not.toBeNull();

    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      valueSetter?.call(textarea, '你');
      const input = new InputEvent('input', {
        bubbles: true,
        data: '你',
        inputType: 'insertCompositionText',
      });
      Object.defineProperty(input, 'isComposing', { value: true });
      textarea?.dispatchEvent(input);

      const enter = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(enter, 'isComposing', { value: true });
      textarea?.dispatchEvent(enter);
    });

    expect(textarea?.value).toBe('你');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does not synchronously measure layout while the draft changes', () => {
    const getComputedStyle = vi.spyOn(window, 'getComputedStyle');

    function Harness() {
      const [value, setValue] = useState('');
      return (
        <ChatInput
          value={value}
          onChange={setValue}
          onSubmit={vi.fn()}
          onStop={vi.fn()}
          mode="ask"
        />
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
          <Harness />
        </ChatSessionProvider>,
      ),
    );

    const textarea = container.querySelector('textarea');
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      valueSetter?.call(textarea, 'a');
      textarea?.dispatchEvent(new Event('input', { bubbles: true }));
      valueSetter?.call(textarea, 'ab');
      textarea?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(getComputedStyle).not.toHaveBeenCalled();
  });
});
