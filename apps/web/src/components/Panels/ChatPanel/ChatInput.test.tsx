// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatSessionProvider } from '@/hooks/useChatSession';

import { ChatInput } from './ChatInput';

import type { ChatMessage } from '@/store/chatTypes';
import type { ChatAttachment, QuotedComment } from '@huabu/shared';

const chatState = {
  pendingAttachments: [] as ChatAttachment[],
  selectionAttachment: null,
  addPendingAttachment: vi.fn(),
  removePendingAttachment: vi.fn(),
  pendingQuotedComments: [] as QuotedComment[],
  updateQuotedComment: vi.fn(),
  removeQuotedComment: vi.fn(),
  setQuotedComments: vi.fn(),
  messages: [] as ChatMessage[],
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
    selectThreadMessages: () => chatState.messages,
    selectThreadPendingAttachments: () => chatState.pendingAttachments,
    selectThreadQuotedComments: () =>
      chatState.pendingQuotedComments.map((comment, index) => ({
        ...comment,
        draftId: `draft-${index}`,
      })),
    useChatStore,
  };
});

vi.mock('@/store/panelStore', () => ({
  usePanelStore: (selector: (state: typeof panelState) => unknown) =>
    selector(panelState),
}));

vi.mock('@/store/canvasStore', () => ({
  default: (selector: (state: { canvasId: null; nodes: never[] }) => unknown) =>
    selector({ canvasId: null, nodes: [] }),
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
  chatState.pendingQuotedComments = [];
  chatState.messages = [];
  chatState.updateQuotedComment.mockClear();
  chatState.removeQuotedComment.mockClear();
  chatState.setQuotedComments.mockClear();
  chatState.addPendingAttachment.mockClear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ChatInput', () => {
  function renderQuotedInput(value = '', isStreaming = false) {
    const onSubmit = vi.fn();
    const onChange = vi.fn();
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
            value={value}
            onChange={onChange}
            onSubmit={onSubmit}
            onStop={vi.fn()}
            mode="ask"
            isStreaming={isStreaming}
          />
        </ChatSessionProvider>,
      ),
    );
    return { onSubmit, onChange };
  }

  it.each(['Explain this.', '   '])(
    'displays quoted comments without an editor and gates quote-only send for %j',
    (comment) => {
      chatState.pendingQuotedComments = [
        {
          quote: 'Original reply',
          contextBefore: 'Before ',
          contextAfter: ' after',
          comment,
        },
      ];
      const { onSubmit } = renderQuotedInput();
      expect(container?.querySelector('blockquote')?.textContent).toBe(
        'Original reply',
      );
      expect(container?.querySelector('input')).toBeNull();
      expect(container?.querySelector('details')).toBeNull();
      expect(container?.textContent).not.toContain('Before');
      expect(container?.textContent).not.toContain(' after');
      expect(
        container
          ?.querySelector('[data-quoted-comment]')
          ?.classList.contains('border'),
      ).toBe(false);
      expect(
        container?.querySelector('[aria-label="messages.editQuotedComment"]')
          ?.textContent,
      ).toBe(comment);
      expect(container?.querySelector('textarea')?.value).toBe('');
      const send = container?.querySelector<HTMLButtonElement>(
        'button[type="submit"]',
      );
      expect(send?.disabled).toBe(!comment.trim());
      act(() => send?.click());
      expect(onSubmit).toHaveBeenCalledTimes(comment.trim() ? 1 : 0);
    },
  );

  it('allows editing and removing a quoted comment without rewriting the main draft', () => {
    chatState.pendingQuotedComments = [
      {
        quote: 'Original reply',
        contextBefore: '',
        contextAfter: '',
        comment: 'Explain.',
      },
    ];
    const { onChange } = renderQuotedInput('General instructions');
    act(() =>
      container
        ?.querySelector<HTMLButtonElement>(
          '[aria-label="messages.editQuotedComment"]',
        )
        ?.click(),
    );
    const input = container?.querySelector<HTMLTextAreaElement>(
      'textarea[name="quoted-comment"]',
    );
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set?.call(input, 'Updated comment');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(chatState.updateQuotedComment).toHaveBeenCalledWith(
      'thread-test',
      0,
      'Updated comment',
    );
    act(() =>
      container
        ?.querySelector<HTMLButtonElement>(
          'button[aria-label="messages.removeQuotedComment"]',
        )
        ?.click(),
    );
    expect(chatState.removeQuotedComment).toHaveBeenCalledWith(
      'thread-test',
      0,
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows a single-line quotation preview and the complete comment without modifying the textarea', () => {
    chatState.pendingQuotedComments = [
      {
        quote: 'Long passage. '.repeat(30),
        contextBefore: '',
        contextAfter: '',
        comment: 'Explain this in detail.\nKeep the entire comment visible.',
      },
    ];
    renderQuotedInput();
    const quote = container?.querySelector('blockquote button');
    expect(quote?.classList.contains('truncate')).toBe(true);
    expect(quote?.textContent).toBe('Long passage. '.repeat(30));
    expect(quote?.getAttribute('title')).toBeNull();
    expect(quote?.tagName).toBe('BUTTON');
    expect(quote?.parentElement?.classList.contains('min-w-0')).toBe(true);
    expect(container?.querySelector('button[aria-expanded]')).toBeNull();
    const comment = container?.querySelector(
      '[aria-label="messages.editQuotedComment"] span',
    );
    expect(comment?.textContent).toBe(
      'Explain this in detail.\nKeep the entire comment visible.',
    );
    expect(comment?.classList.contains('whitespace-pre-wrap')).toBe(true);
    expect(container?.querySelector('textarea')?.value).toBe('');
  });

  it.each([
    [false, false],
    [false, true],
    [true, false],
  ])(
    'finishes editing without sending with streaming %s and composition %s',
    (streaming, composing) => {
      chatState.pendingQuotedComments = [
        {
          quote: 'Original reply',
          contextBefore: '',
          contextAfter: '',
          comment: 'Explain.',
        },
      ];
      const { onSubmit } = renderQuotedInput('', streaming);
      act(() =>
        container
          ?.querySelector<HTMLButtonElement>(
            '[aria-label="messages.editQuotedComment"]',
          )
          ?.click(),
      );
      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, 'isComposing', { value: composing });
      act(() =>
        container
          ?.querySelector('textarea[name="quoted-comment"]')
          ?.dispatchEvent(event),
      );
      expect(event.defaultPrevented).toBe(true);
      expect(onSubmit).not.toHaveBeenCalled();
      expect(
        container?.querySelector('textarea[name="quoted-comment"]') !== null,
      ).toBe(composing);
    },
  );

  it('recalls structured quoted comments with prompt history and restores the unsent draft', () => {
    const currentQuotes = [
      {
        quote: 'Current quote',
        contextBefore: '',
        contextAfter: '',
        comment: 'Current comment',
      },
    ];
    const previousQuotes = [
      {
        quote: 'Previous quote',
        contextBefore: '',
        contextAfter: '',
        comment: 'Previous comment',
      },
    ];
    chatState.pendingQuotedComments = currentQuotes;
    chatState.messages = [
      { id: 'old', role: 'user', content: '', quotedComments: previousQuotes },
    ];
    const { onChange } = renderQuotedInput('Unsent draft');
    const textarea = container?.querySelector('textarea');
    act(() => {
      textarea?.setSelectionRange(0, 0);
      textarea?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }),
      );
    });
    expect(onChange).toHaveBeenLastCalledWith('');
    expect(chatState.setQuotedComments).toHaveBeenLastCalledWith(
      'thread-test',
      previousQuotes,
    );
    act(() => {
      textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
      textarea?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });
    expect(onChange).toHaveBeenLastCalledWith('Unsent draft');
    expect(chatState.setQuotedComments).toHaveBeenLastCalledWith(
      'thread-test',
      currentQuotes.map((comment, index) => ({
        ...comment,
        draftId: `draft-${index}`,
      })),
    );
  });

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
