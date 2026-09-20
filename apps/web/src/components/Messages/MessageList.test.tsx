// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageList } from './MessageList';
import {
  forgetMessageListScrollPosition,
  rememberMessageListScrollPosition,
} from './messageListScroll';

import type { ChatMessage } from '../../store/chatTypes';

const renderCounts = vi.hoisted(() => ({
  assistant: new Map<string, number>(),
  user: 0,
  userInputKinds: [] as Array<string | undefined>,
  userInferredIntents: [] as Array<string | undefined>,
  userGroundingValues: [] as unknown[],
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
    UserMessage: memo(function MockUserMessage({
      inputKind,
      inferredIntent,
      groundingVisual,
    }: {
      inputKind?: string;
      inferredIntent?: string;
      groundingVisual?: unknown;
    }) {
      renderCounts.user++;
      renderCounts.userInputKinds.push(inputKind);
      renderCounts.userInferredIntents.push(inferredIntent);
      renderCounts.userGroundingValues.push(groundingVisual);
      return <div data-user-message />;
    }),
  };
});

vi.mock('./StatusMessage', () => ({
  StatusMessage: () => <div data-status-message />,
}));

vi.mock('../Common/Button', () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock('../Common/Loading', () => ({
  Loading: () => <div data-loading />,
}));

vi.mock('../Common/ThinkingIndicator', () => ({
  ThinkingIndicator: () => <div data-thinking />,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { count?: number }) => {
      if (key === 'chat.showEarlierTurns') {
        return `Show ${values?.count ?? 0} earlier turns`;
      }
      if (key === 'chat.loadingEarlierTurns') return 'Loading earlier turns…';
      if (key === 'chat.backToBottom') return 'Back to bottom';
      if (key === 'chat.newMessage') return 'New message';
      return key;
    },
  }),
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
  renderCounts.userInputKinds = [];
  renderCounts.userInferredIntents = [];
  renderCounts.userGroundingValues = [];
  vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(() => {});
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('MessageList bottom navigation', () => {
  let height: number;
  let viewportHeight: number;
  let top: number;
  let resizes: Set<() => void>;
  let observe: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    height = 1_000;
    viewportHeight = 200;
    top = 0;
    resizes = new Set();
    observe = vi.fn();
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(
      () => height,
    );
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(
      () => viewportHeight,
    );
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(
      () => top,
    );
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(
      (value) => {
        top = Math.max(0, Math.min(value, height - viewportHeight));
      },
    );
    vi.mocked(HTMLElement.prototype.scrollTo).mockImplementation(function (
      this: HTMLElement,
      options?: ScrollToOptions | number,
    ) {
      if (typeof options === 'object') this.scrollTop = options.top ?? 0;
    });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        callback: () => void;
        constructor(callback: () => void) {
          this.callback = callback;
          resizes.add(callback);
        }
        observe = observe;
        disconnect() {
          resizes.delete(this.callback);
        }
      },
    );
  });

  function thread(): HTMLElement {
    const element = container?.querySelector<HTMLElement>(
      '[data-chat-thread-root]',
    );
    if (!element) throw new Error('Thread is not mounted');
    return element;
  }

  function scrollTo(value: number): void {
    act(() => {
      thread().scrollTop = value;
      thread().dispatchEvent(new Event('scroll', { bubbles: true }));
    });
  }

  function resize(): void {
    act(() => {
      for (const callback of resizes) callback();
    });
  }

  function bottomButton(): HTMLButtonElement | undefined {
    return Array.from(container?.querySelectorAll('button') ?? []).find(
      (button) => /Back to bottom|New message/.test(button.textContent ?? ''),
    );
  }

  it('shows back-to-bottom only beyond 50px even without new messages', () => {
    mount(<MessageList messages={[]} isLoading={false} />);
    expect(top).toBe(800);
    scrollTo(750);
    expect(bottomButton()).toBeUndefined();
    scrollTo(749);
    expect(bottomButton()?.textContent).toContain('Back to bottom');
    scrollTo(750);
    expect(bottomButton()).toBeUndefined();
  });

  it('jumps instantly and follows late content and viewport growth', () => {
    mount(<MessageList messages={[]} isLoading={false} />);
    scrollTo(100);
    act(() => bottomButton()?.click());
    expect(top).toBe(800);
    expect(bottomButton()).toBeUndefined();
    expect(HTMLElement.prototype.scrollTo).toHaveBeenLastCalledWith({
      top: 1_000,
      behavior: 'instant',
    });
    height = 1_500;
    resize();
    expect(top).toBe(1_300);
    viewportHeight = 100;
    resize();
    expect(top).toBe(1_400);
    expect(observe).toHaveBeenCalledWith(thread());
    expect(observe).toHaveBeenCalledWith(thread().firstElementChild);
    expect(
      vi
        .mocked(HTMLElement.prototype.scrollTo)
        .mock.calls.every(
          ([options]) =>
            typeof options === 'object' && options.behavior === 'instant',
        ),
    ).toBe(true);
  });

  it('does not hide the button before the scroll actually reaches bottom', () => {
    mount(<MessageList messages={[]} isLoading={false} />);
    scrollTo(100);
    vi.mocked(HTMLElement.prototype.scrollTo).mockImplementation(() => {});
    act(() => bottomButton()?.click());
    expect(top).toBe(100);
    expect(bottomButton()).toBeDefined();
  });

  it('keeps following when growth emits a scroll event without movement', () => {
    mount(<MessageList messages={[]} isLoading={false} />);
    height = 1_500;
    act(() => thread().dispatchEvent(new Event('scroll')));
    resize();
    expect(top).toBe(1_300);
    expect(bottomButton()).toBeUndefined();
  });

  it('never pulls a paused reader down on delayed resize or streamed updates', () => {
    const tail: ChatMessage = {
      id: 'assistant-live',
      role: 'assistant',
      segments: [{ kind: 'text', text: 'First' }],
    };
    mount(<MessageList messages={[tail]} isLoading />);
    scrollTo(100);
    height = 1_500;
    resize();
    expect(top).toBe(100);
    expect(bottomButton()?.textContent).toContain('Back to bottom');
    act(() =>
      root?.render(
        <MessageList
          messages={[
            { ...tail, segments: [{ kind: 'text', text: 'More output' }] },
          ]}
          isLoading
        />,
      ),
    );
    expect(top).toBe(100);
    expect(bottomButton()?.textContent).toContain('New message');
    scrollTo(1_300);
    expect(bottomButton()).toBeUndefined();
    height = 1_700;
    resize();
    expect(top).toBe(1_500);
  });

  it('honors an upward gesture before resize without preventing native scrolling', () => {
    mount(<MessageList messages={[]} isLoading={false} />);
    const wheel = new WheelEvent('wheel', {
      deltaY: -100,
      bubbles: true,
      cancelable: true,
    });
    act(() => thread().dispatchEvent(wheel));
    height = 1_500;
    resize();
    expect(wheel.defaultPrevented).toBe(false);
    expect(top).toBe(800);
    expect(bottomButton()).toBeDefined();
  });

  it('does not stop following for downward wheel input already at bottom', () => {
    mount(<MessageList messages={[]} isLoading={false} />);
    act(() =>
      thread().dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: 100,
          bubbles: true,
        }),
      ),
    );
    height = 1_500;
    resize();
    expect(top).toBe(1_300);
  });

  it('does not undo native scrolling before its scroll event arrives', () => {
    mount(<MessageList messages={[]} isLoading={false} />);
    thread().scrollTop = 100;
    height = 1_500;
    resize();
    expect(top).toBe(100);
    expect(bottomButton()).toBeDefined();
  });

  it('keeps keyboard focus in the thread after activating the bottom action', () => {
    mount(<MessageList messages={[]} isLoading={false} />);
    scrollTo(100);
    const button = bottomButton();
    button?.focus();
    act(() => button?.click());
    expect(document.activeElement).toBe(thread());
    expect(top).toBe(800);
    act(() =>
      thread().dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'End',
          bubbles: true,
        }),
      ),
    );
    height = 1_500;
    resize();
    expect(top).toBe(1_300);
    act(() =>
      thread().dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'PageUp',
          bubbles: true,
        }),
      ),
    );
    height = 1_700;
    resize();
    expect(top).toBe(1_300);
  });

  it('does not flag a prepend with the same tail as new output', () => {
    const tail: ChatMessage = {
      id: 'current',
      role: 'user',
      content: 'Current',
    };
    mount(<MessageList messages={[tail]} isLoading={false} />);
    scrollTo(100);
    act(() =>
      root?.render(
        <MessageList
          messages={[{ id: 'older', role: 'user', content: 'Older' }, tail]}
          isLoading={false}
        />,
      ),
    );
    expect(top).toBe(100);
    expect(bottomButton()?.textContent).toContain('Back to bottom');
  });

  it('waits for hydration and disconnects observers on unmount', () => {
    mount(<MessageList messages={[]} isLoading={false} isHistoryLoading />);
    expect(top).toBe(0);
    expect(bottomButton()).toBeUndefined();
    act(() => root?.render(<MessageList messages={[]} isLoading={false} />));
    expect(top).toBe(800);
    expect(resizes.size).toBe(1);
    act(() => root?.unmount());
    root = undefined;
    expect(resizes.size).toBe(0);
  });

  it('ignores hidden-tab scroll events and resize callbacks', () => {
    mount(
      <div data-preview-active="true">
        <MessageList messages={[]} isLoading={false} />
      </div>,
    );
    const wrapper = container?.querySelector<HTMLElement>(
      '[data-preview-active]',
    );
    wrapper?.setAttribute('data-preview-active', 'false');
    height = 1_500;
    resize();
    expect(top).toBe(800);
    wrapper?.setAttribute('data-preview-active', 'true');
    resize();
    expect(top).toBe(1_300);
  });
});

describe('MessageList render isolation', () => {
  it('forwards the persisted input kind to user-message rendering', () => {
    mount(
      <MessageList
        messages={[
          {
            id: 'ink-user',
            role: 'user',
            content: '',
            inputKind: 'ink-intent',
            inferredIntent: 'Expand the third step',
            groundingVisual: {
              kind: 'visible-canvas',
              dataUrl: 'data:image/png;base64,cG5n',
              viewport: {
                x: 0,
                y: 0,
                zoom: 1,
                width: 100,
                height: 100,
                devicePixelRatio: 1,
              },
              crop: { x: 0, y: 0, width: 100, height: 100 },
              selectedNodeIds: ['note-1'],
              strokeSubsets: [{ nodeId: 'sketch-1', strokeIds: ['stroke-1'] }],
            },
          },
        ]}
        isLoading={false}
      />,
    );

    expect(renderCounts.userInputKinds).toEqual(['ink-intent']);
    expect(renderCounts.userInferredIntents).toEqual(['Expand the third step']);
    expect(renderCounts.userGroundingValues).toEqual([undefined]);
  });

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

describe('MessageList opening position', () => {
  it('restores a saved position and offers new messages without auto-scrolling', () => {
    const viewKey = 'canvas-1:thread-1';
    rememberMessageListScrollPosition(viewKey, 240);
    const scrollHeight = vi
      .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
      .mockReturnValue(1_000);
    const clientHeight = vi
      .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
      .mockReturnValue(200);

    try {
      mount(
        <MessageList
          messages={[]}
          isLoading={false}
          viewKey={viewKey}
          openPosition="last-user"
          openPositionRequestNonce={1}
        />,
      );

      const messageContainer = container?.querySelector<HTMLElement>(
        '[data-chat-thread-root]',
      );
      expect(messageContainer?.scrollTop).toBe(240);
      expect(container?.textContent).toContain('New message');
    } finally {
      scrollHeight.mockRestore();
      clientHeight.mockRestore();
    }
  });

  it('restores the same visible message after a cold remount', () => {
    const viewKey = 'canvas-1:thread-semantic-anchor';
    const messages: ChatMessage[] = [
      { id: 'user-1', role: 'user', content: 'Question 1' },
      { id: 'user-2', role: 'user', content: 'Question 2' },
    ];
    let remounted = false;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        const messageId = this.dataset.chatMessageId;
        if (this.hasAttribute('data-chat-thread-root')) {
          return {
            x: 0,
            y: 0,
            width: 100,
            height: 200,
            top: 0,
            right: 100,
            bottom: 200,
            left: 0,
            toJSON: () => ({}),
          };
        }
        const top = messageId === 'user-2' ? (remounted ? 300 : 40) : -100;
        return {
          x: 0,
          y: top,
          width: 100,
          height: 20,
          top,
          right: 100,
          bottom: top + 20,
          left: 0,
          toJSON: () => ({}),
        };
      },
    );

    mount(
      <MessageList messages={messages} isLoading={false} viewKey={viewKey} />,
    );
    const firstContainer = container?.querySelector<HTMLElement>(
      '[data-chat-thread-root]',
    );
    if (firstContainer) {
      firstContainer.scrollTop = 200;
      act(() => firstContainer.dispatchEvent(new Event('scroll')));
    }
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;

    remounted = true;
    mount(
      <MessageList messages={messages} isLoading={false} viewKey={viewKey} />,
    );

    const remountedThreadRoot = document.querySelector<HTMLElement>(
      '[data-chat-thread-root]',
    );
    expect(remountedThreadRoot?.scrollTop).toBe(260);
    forgetMessageListScrollPosition(viewKey);
  });
});

describe('MessageList older history', () => {
  it('exposes an accessible explicit expansion control', () => {
    const onLoadOlderHistory = vi.fn();
    mount(
      <MessageList
        messages={[]}
        isLoading={false}
        hasOlderHistory
        olderTurnBatchSize={3}
        onLoadOlderHistory={onLoadOlderHistory}
      />,
    );

    const button = Array.from(container?.querySelectorAll('button') ?? []).find(
      (candidate) => candidate.textContent === 'Show 3 earlier turns',
    );
    expect(button).not.toBeUndefined();

    act(() => button?.click());
    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);
  });

  it('preserves the first visible message while prepending older history', () => {
    const current: ChatMessage[] = [
      { id: 'user-2', role: 'user', content: 'Question 2' },
      {
        id: 'assistant-2',
        role: 'assistant',
        segments: [{ kind: 'text', text: 'Answer 2' }],
      },
    ];
    const prepended: ChatMessage[] = [
      { id: 'user-1', role: 'user', content: 'Question 1' },
      {
        id: 'assistant-1',
        role: 'assistant',
        segments: [{ kind: 'text', text: 'Answer 1' }],
      },
      ...current,
    ];
    let didPrepend = false;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        const messageId = this.dataset.chatMessageId;
        const top = messageId === 'user-2' ? (didPrepend ? 100 : 40) : -100;
        return {
          x: 0,
          y: top,
          width: 100,
          height: 20,
          top,
          right: 100,
          bottom: top + 20,
          left: 0,
          toJSON: () => ({}),
        };
      },
    );

    const renderList = (messages: ChatMessage[]) => (
      <MessageList
        messages={messages}
        isLoading={false}
        hasOlderHistory={!didPrepend}
        olderTurnBatchSize={1}
        onLoadOlderHistory={() => {
          didPrepend = true;
          root?.render(renderList(prepended));
        }}
      />
    );
    mount(renderList(current));
    const messageContainer = container?.querySelector<HTMLElement>(
      '[data-chat-thread-root]',
    );
    if (messageContainer) messageContainer.scrollTop = 200;
    const button = Array.from(container?.querySelectorAll('button') ?? []).find(
      (candidate) => candidate.textContent === 'Show 1 earlier turns',
    );

    act(() => button?.click());

    expect(messageContainer?.scrollTop).toBe(260);
  });
});
