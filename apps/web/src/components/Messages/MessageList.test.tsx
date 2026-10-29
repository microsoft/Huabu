// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageList } from './MessageList';

import type { ChatMessage } from '@/store/chatTypes';
import type { ScrollSeekConfiguration } from 'react-virtuoso';

const virtual = vi.hoisted(() => ({
  jump: vi.fn(),
  props: {} as Record<string, unknown>,
}));
vi.mock('react-virtuoso', async () => {
  const { useImperativeHandle } = await import('react');
  return {
    Virtuoso: (props: {
      ref: React.Ref<unknown>;
      data: string[];
      itemContent: (index: number, id: string) => React.ReactNode;
      firstItemIndex: number;
    }) => {
      virtual.props = props;
      useImperativeHandle(props.ref, () => ({ scrollToIndex: virtual.jump }));
      return props.data.map((id, index) => (
        <div key={id}>
          {props.itemContent(props.firstItemIndex + index, id)}
        </div>
      ));
    },
  };
});
vi.mock('./AIMessage', () => ({
  AIMessage: ({
    messageId,
    isStreaming,
    enableComments,
    endStatus,
  }: {
    messageId: string;
    isStreaming: boolean;
    enableComments: boolean;
    endStatus?: string;
  }) => (
    <div
      data-assistant={messageId}
      data-streaming={isStreaming}
      data-comments={enableComments}
      data-end-status={endStatus}
    />
  ),
}));
vi.mock('./UserMessage', () => ({
  UserMessage: ({
    content,
    isFirst,
    inputKind,
  }: {
    content: string;
    isFirst: boolean;
    inputKind?: string;
  }) => (
    <div data-user data-first={isFirst} data-input-kind={inputKind}>
      {content}
    </div>
  ),
}));
vi.mock('./StatusMessage', () => ({
  StatusMessage: () => <div data-status />,
}));
vi.mock('../Common/Button', () => ({
  Button: ({
    children,
    onClick,
    'aria-label': label,
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button onClick={onClick} aria-label={label}>
      {children}
    </button>
  ),
}));
vi.mock('../Common/Loading', () => ({
  Loading: ({ variant }: { variant?: string }) => (
    <div
      data-loading
      data-loading-spinner={variant === 'spinner' ? '' : undefined}
    />
  ),
}));
vi.mock('../Common/ThinkingIndicator', () => ({
  ThinkingIndicator: () => <div data-thinking />,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const messages: ChatMessage[] = [
  { id: 'user', role: 'user', content: 'Hello', inputKind: 'ink-intent' },
  {
    id: 'assistant',
    role: 'assistant',
    segments: [{ kind: 'text', text: 'Answer' }],
  },
];
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) =>
    setTimeout(() => fn(0), 16),
  );
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  virtual.jump.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function render(props: Partial<React.ComponentProps<typeof MessageList>> = {}) {
  act(() =>
    root.render(
      <MessageList messages={messages} isLoading={false} {...props} />,
    ),
  );
  act(() => vi.advanceTimersByTime(600));
}

describe('automatic viewport fill', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private callback: ResizeObserverCallback) {}
        observe(target: Element) {
          this.callback(
            [
              {
                target,
                contentRect: target.getBoundingClientRect(),
                borderBoxSize: [],
                contentBoxSize: [],
                devicePixelContentBoxSize: [],
              },
            ],
            this,
          );
        }
        disconnect() {}
        unobserve() {}
      },
    );
  });

  function measure() {
    act(() => {
      (virtual.props.totalListHeightChanged as (height: number) => void)(240);
    });
    act(() => vi.advanceTimersByTime(600));
  }

  it('fills a measured short viewport without enabling output following', () => {
    const load = vi.fn();
    render({ hasOlderHistory: true, onLoadOlderHistory: load });
    measure();
    expect(load).toHaveBeenCalledOnce();
    expect(virtual.props.followOutput).toBe(false);
  });

  it.each(['pointerup', 'pointercancel', 'blur'])(
    'resumes a fill deferred by a held pointer after %s',
    (event) => {
      const load = vi.fn();
      render({ hasOlderHistory: true, onLoadOlderHistory: load });
      const scroller = container.querySelector('[data-chat-thread-root]');
      if (!scroller) throw new Error('Missing scroller');
      act(() => {
        scroller.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      });
      measure();
      expect(load).not.toHaveBeenCalled();
      virtual.jump.mockClear();
      act(() => window.dispatchEvent(new Event(event)));
      act(() => vi.advanceTimersByTime(600));
      expect(load).toHaveBeenCalledOnce();
      expect(virtual.jump).not.toHaveBeenCalled();
      act(() => window.dispatchEvent(new Event(event)));
      act(() => vi.advanceTimersByTime(600));
      expect(load).toHaveBeenCalledOnce();
    },
  );

  it.each<Partial<React.ComponentProps<typeof MessageList>>>([
    { isActive: false },
    { isHistoryReady: false },
    { isHistoryLoading: true },
    { isLoading: true },
    { isLoadingOlderHistory: true },
    { olderHistoryError: 'Offline' },
    { historyPageError: 'Refill failed' },
    { hasOlderHistory: false },
    { historyPages: [{ limit: 3, messageIds: ['missing'], loaded: false }] },
  ])('does not fill an unavailable or unsettled view: %j', (props) => {
    const load = vi.fn();
    render({ hasOlderHistory: true, onLoadOlderHistory: load, ...props });
    measure();
    expect(load).not.toHaveBeenCalled();
  });

  it('does not fill an already scrollable viewport', () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(
      1000,
    );
    const load = vi.fn();
    render({ hasOlderHistory: true, onLoadOlderHistory: load });
    measure();
    expect(load).not.toHaveBeenCalled();
  });

  it('cancels the fill-to-latest request when the reader takes control', () => {
    const load = vi.fn();
    render({ hasOlderHistory: true, onLoadOlderHistory: load });
    measure();
    render({
      hasOlderHistory: true,
      onLoadOlderHistory: load,
      isLoadingOlderHistory: true,
    });
    act(() =>
      container
        .querySelector('[data-chat-thread-root]')
        ?.dispatchEvent(
          new WheelEvent('wheel', { bubbles: true, deltaY: -10 }),
        ),
    );
    virtual.jump.mockClear();
    render({
      hasOlderHistory: false,
      onLoadOlderHistory: load,
      messages: [
        {
          id: 'older',
          role: 'user',
          content: 'Earlier question',
          historyTurnId: 'earlier',
        },
        ...messages,
      ],
    });
    expect(virtual.jump).not.toHaveBeenCalled();
  });
});

describe('manual virtual chat', () => {
  it('reports the latest end only after hydration and placement, and clears it when hidden', () => {
    const onLatestVisibleChange = vi.fn();
    render({ onLatestVisibleChange, isHistoryReady: false });
    expect(onLatestVisibleChange).toHaveBeenLastCalledWith(false);
    render({ onLatestVisibleChange });
    expect(onLatestVisibleChange).toHaveBeenLastCalledWith(true);
    const scroller = container.querySelector<HTMLElement>(
      '[data-chat-thread-root]',
    );
    if (!scroller) throw new Error('Missing scroller');
    Object.defineProperty(scroller, 'scrollHeight', { value: 2000 });
    act(() => {
      scroller.scrollTop = 500;
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(onLatestVisibleChange).toHaveBeenLastCalledWith(false);
    act(() => {
      scroller.scrollTop = 1500;
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(onLatestVisibleChange).toHaveBeenLastCalledWith(true);
    render({ onLatestVisibleChange, isActive: false });
    expect(onLatestVisibleChange).toHaveBeenLastCalledWith(false);
  });

  it('does not acknowledge the latest end while its body is a refill placeholder', () => {
    const onLatestVisibleChange = vi.fn();
    render({
      onLatestVisibleChange,
      messages: [],
      historyPages: [{ limit: 3, messageIds: ['missing-tail'], loaded: false }],
    });
    expect(onLatestVisibleChange).toHaveBeenLastCalledWith(false);
  });

  it('keeps the return control stable between separate show and hide thresholds', () => {
    render();
    const scroller = container.querySelector<HTMLElement>(
      '[data-chat-thread-root]',
    );
    if (!scroller) throw new Error('Missing scroller');
    Object.defineProperty(scroller, 'scrollHeight', { value: 2000 });
    const button = () =>
      container.querySelector('[aria-label="chat.backToBottom"]');
    const scrollToGap = (gap: number) =>
      act(() => {
        scroller.scrollTop = 1500 - gap;
        scroller.dispatchEvent(new Event('scroll'));
      });
    for (const gap of [0, 51, 160]) {
      scrollToGap(gap);
      expect(button()).toBeNull();
    }
    scrollToGap(161);
    const visible = button();
    expect(visible).not.toBeNull();
    expect(visible?.textContent).toBe('');
    expect(visible?.querySelector('svg')).not.toBeNull();
    for (const gap of [159, 100, 51, 160]) {
      scrollToGap(gap);
      expect(button()).toBe(visible);
    }
    scrollToGap(50);
    expect(button()).toBeNull();
    scrollToGap(100);
    expect(button()).toBeNull();
  });

  it('keeps the measured outer height when a body is evicted repeatedly', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 0, 300, 480),
    );
    const page = { messageIds: ['assistant'], limit: 3, loaded: true };
    render({ historyPages: [page] });
    for (let count = 0; count < 2; count++) {
      render({ messages: [], historyPages: [{ ...page, loaded: false }] });
      const row = container.querySelector<HTMLElement>(
        '[data-chat-message-id="assistant"]',
      );
      expect(row?.style.height).toBe('480px');
      expect(row?.hasAttribute('data-chat-row-loading')).toBe(true);
      render({ historyPages: [page] });
    }
  });

  it('defers passing-page refills while seeking and keeps loading through target refill', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 0, 300, 480),
    );
    const page = {
      messageIds: ['older'],
      before: 'cursor',
      limit: 3,
      loaded: false,
    };
    const load = vi.fn();
    render({ historyPages: [page], onLoadHistoryPage: load });
    act(() =>
      container
        .querySelector('[data-chat-thread-root]')
        ?.dispatchEvent(new Event('pointerdown', { bubbles: true })),
    );
    const config = virtual.props
      .scrollSeekConfiguration as ScrollSeekConfiguration;
    const range = { startIndex: 1_000_000, endIndex: 1_000_000 };
    expect(config.enter(200, range)).toBe(false);
    act(() => {
      expect(config.enter(1200, range)).toBe(true);
    });
    const scroller = container.querySelector<HTMLElement>(
      '[data-chat-thread-root]',
    );
    act(() => {
      if (!scroller) throw new Error('Missing scroller');
      scroller.scrollTop = 1000;
      scroller.dispatchEvent(new Event('scroll'));
    });
    act(() =>
      (virtual.props.rangeChanged as (next: typeof range) => void)(range),
    );
    expect(load).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-chat-scroll-loading]'),
    ).not.toBeNull();
    act(() => {
      expect(config.exit(0, range)).toBe(true);
    });
    expect(load).toHaveBeenCalledWith(page);
    act(() => vi.advanceTimersByTime(600));
    expect(
      container.querySelector('[data-chat-scroll-loading]'),
    ).not.toBeNull();
    render({
      messages: [{ id: 'older', role: 'user', content: 'Loaded' }, ...messages],
      historyPages: [{ ...page, loaded: true }],
      onLoadHistoryPage: load,
    });
    expect(container.querySelector('[data-chat-scroll-loading]')).toBeNull();
  });

  it('uses row placeholders without whole-viewport loading for ordinary fast scrolling', () => {
    render();
    act(() =>
      container
        .querySelector('[data-chat-thread-root]')
        ?.dispatchEvent(new Event('pointerdown', { bubbles: true })),
    );
    const config = virtual.props
      .scrollSeekConfiguration as ScrollSeekConfiguration;
    act(() => {
      expect(
        config.enter(1200, { startIndex: 1_000_000, endIndex: 1_000_001 }),
      ).toBe(true);
    });
    expect(container.querySelector('[data-chat-scroll-loading]')).toBeNull();
  });

  it.each([-400, 600])(
    'releases whole-viewport loading while only overscan at %spx remains missing',
    (top) => {
      vi.spyOn(
        HTMLElement.prototype,
        'getBoundingClientRect',
      ).mockImplementation(function (this: HTMLElement) {
        return this.dataset.chatMessageId === 'older'
          ? new DOMRect(0, top, 300, 300)
          : new DOMRect(0, 0, 300, 480);
      });
      const page = {
        messageIds: ['older'],
        before: 'cursor',
        limit: 3,
        loaded: false,
      };
      const load = vi.fn();
      render({ historyPages: [page], onLoadHistoryPage: load });
      const scroller = container.querySelector<HTMLElement>(
        '[data-chat-thread-root]',
      );
      act(() => {
        if (!scroller) throw new Error('Missing scroller');
        scroller.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        scroller.scrollTop = 1000;
        scroller.dispatchEvent(new Event('scroll'));
        (
          virtual.props.rangeChanged as (range: {
            startIndex: number;
            endIndex: number;
          }) => void
        )({ startIndex: 1_000_000, endIndex: 1_000_002 });
      });
      expect(
        container.querySelector('[data-chat-scroll-loading]'),
      ).not.toBeNull();
      expect(load).toHaveBeenCalledWith(page);
      act(() => vi.advanceTimersByTime(600));
      expect(container.querySelector('[data-chat-scroll-loading]')).toBeNull();
      expect(
        container.querySelector(
          '[data-chat-message-id="older"][aria-busy=true]',
        ),
      ).not.toBeNull();
      expect(container.querySelectorAll('[data-loading-spinner]')).toHaveLength(
        0,
      );
    },
  );

  it('opens at latest once without following unsolicited output', () => {
    render();
    expect(virtual.jump).toHaveBeenCalledWith(
      expect.objectContaining({ index: 1, align: 'end' }),
    );
    expect(virtual.props.followOutput).toBe(false);
    virtual.jump.mockClear();
    render({
      messages: [
        ...messages,
        {
          id: 'next',
          role: 'assistant',
          segments: [{ kind: 'text', text: 'Next' }],
        },
      ],
      isLoading: true,
    });

    render({ messages: [...messages] });
    expect(virtual.jump).not.toHaveBeenCalled();
  });

  it('follows a new local send at bottom and stops immediately on upward input', () => {
    render();
    virtual.jump.mockClear();
    const sent: ChatMessage[] = [
      ...messages,
      { id: 'send', role: 'user', content: 'Next' },
    ];
    render({ messages: sent, isLoading: true });
    expect(virtual.jump).toHaveBeenCalledWith(
      expect.objectContaining({ index: 2, align: 'end' }),
    );
    act(() =>
      container
        .querySelector('[data-chat-thread-root]')
        ?.dispatchEvent(
          new WheelEvent('wheel', { bubbles: true, deltaY: -100 }),
        ),
    );
    virtual.jump.mockClear();
    render({
      messages: [
        ...sent,
        {
          id: 'response',
          role: 'assistant',
          segments: [{ kind: 'text', text: 'Answer' }],
        },
      ],
      isLoading: true,
    });
    expect(virtual.jump).not.toHaveBeenCalled();
  });

  it('does not follow a new local send while reading history', () => {
    render();
    const scroller = container.querySelector<HTMLElement>(
      '[data-chat-thread-root]',
    );
    if (!scroller) throw new Error('Missing scroller');
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      value: 2000,
    });
    act(() => scroller.dispatchEvent(new Event('scroll')));
    virtual.jump.mockClear();
    render({
      messages: [...messages, { id: 'send', role: 'user', content: 'Next' }],
      isLoading: true,
    });
    expect(virtual.jump).not.toHaveBeenCalled();
  });
  it('follows the first send in an empty hydrated thread', () => {
    render({ messages: [] });
    virtual.jump.mockClear();
    render({
      messages: [{ id: 'first', role: 'user', content: 'First' }],
      isLoading: true,
    });
    expect(virtual.jump).toHaveBeenCalledWith(
      expect.objectContaining({ index: 0, align: 'end' }),
    );
  });

  it('does not enable follow for an active turn arriving through hydration', () => {
    render({ messages: [], isHistoryLoading: true, isHistoryReady: false });
    const hydrated: ChatMessage[] = [
      {
        id: 'hydrated',
        historyTurnId: 'turn',
        historyTurnActive: true,
        role: 'user',
        content: 'Existing send',
      },
    ];
    render({ messages: hydrated, isHistoryReady: true });
    virtual.jump.mockClear();
    render({
      messages: [
        ...hydrated,
        {
          id: 'response',
          role: 'assistant',
          segments: [{ kind: 'text', text: 'Output' }],
        },
      ],
      isLoading: true,
    });
    expect(virtual.jump).not.toHaveBeenCalled();
  });

  it('does not position failed or pending hydration', () => {
    render({ isHistoryLoading: true, isHistoryReady: false });
    render({ isHistoryLoading: false, isHistoryReady: false });
    expect(virtual.jump).not.toHaveBeenCalled();
    render({ isHistoryReady: true });
    expect(virtual.jump).toHaveBeenCalledTimes(1);
  });

  it('honors one explicit last-user request', () => {
    render({ openPosition: 'last-user', openPositionRequestNonce: 1 });
    expect(virtual.jump).toHaveBeenCalledWith(
      expect.objectContaining({ index: 0, align: 'start' }),
    );
    virtual.jump.mockClear();
    render({ openPosition: 'last-user', openPositionRequestNonce: 1 });
    expect(virtual.jump).not.toHaveBeenCalled();
  });

  it('preserves rendering contracts and only marks the actual live assistant', () => {
    render({ isLoading: true });
    expect(
      container.querySelector('[data-user]')?.getAttribute('data-input-kind'),
    ).toBe('ink-intent');
    expect(
      container
        .querySelector('[data-assistant]')
        ?.getAttribute('data-streaming'),
    ).toBe('true');
    expect(
      container
        .querySelector('[data-assistant]')
        ?.getAttribute('data-comments'),
    ).toBe('true');
    render({
      messages: [...messages, { id: 'next', role: 'user', content: 'Next' }],
      isLoading: true,
    });
    expect(
      container
        .querySelector('[data-assistant]')
        ?.getAttribute('data-streaming'),
    ).toBe('false');
    const thinking = container.querySelector('[data-thinking]');
    expect(thinking).not.toBeNull();
    expect(thinking?.parentElement?.className).toBe('ml-1 px-4 py-2');
    expect(thinking?.parentElement?.parentElement?.className).toBe('px-3');
    render({ isLoading: true });
    expect(container.querySelector('[data-thinking]')).toBeNull();
  });

  it('preserves end status and disables comments in inactive panels', () => {
    render({
      messages: [
        ...messages,
        { id: 'status', role: 'status', status: 'interrupted' },
      ],
      isActive: false,
    });
    expect(
      container
        .querySelector('[data-assistant]')
        ?.getAttribute('data-end-status'),
    ).toBe('interrupted');
    expect(
      container
        .querySelector('[data-assistant]')
        ?.getAttribute('data-comments'),
    ).toBe('false');
    expect(virtual.jump).not.toHaveBeenCalled();
  });

  it('uses metadata to keep evicted messages addressable and fetches visible pages', () => {
    const page = {
      before: 'cursor',
      limit: 3,
      messageIds: ['older'],
      loaded: false,
    };
    const load = vi.fn();
    render({ historyPages: [page], onLoadHistoryPage: load });
    expect(virtual.props.data).toEqual(['older', 'user', 'assistant']);
    act(() => {
      const onRange = virtual.props.rangeChanged as (range: {
        startIndex: number;
        endIndex: number;
      }) => void;
      onRange({ startIndex: 1_000_000, endIndex: 1_000_001 });
    });
    expect(load).toHaveBeenCalledWith(page);
    expect(container.querySelector('[aria-busy=true]')).not.toBeNull();
  });

  it('automatically requests older history without a show-earlier button', () => {
    const load = vi.fn();
    render({ hasOlderHistory: true, onLoadOlderHistory: load });
    act(() =>
      container
        .querySelector('[data-chat-thread-root]')
        ?.dispatchEvent(new Event('pointerdown', { bubbles: true })),
    );
    act(() => (virtual.props.startReached as () => void)());
    expect(load).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain('chat.showEarlierTurns');
  });

  it('stops automatic retries on page errors and offers an explicit retry', () => {
    const load = vi.fn();
    render({
      hasOlderHistory: true,
      olderHistoryError: 'Offline',
      onLoadOlderHistory: load,
    });
    act(() => (virtual.props.startReached as () => void)());
    expect(load).not.toHaveBeenCalled();
    expect(container.querySelector('[role=alert]')?.textContent).toContain(
      'Offline',
    );
    act(() => container.querySelector('button')?.click());
    expect(load).toHaveBeenCalledOnce();
  });

  it('loads older turns on upward keyboard intent even when the list cannot scroll', () => {
    const load = vi.fn();
    render({ hasOlderHistory: true, onLoadOlderHistory: load });
    expect(load).not.toHaveBeenCalled();
    act(() =>
      container
        .querySelector('[data-chat-thread-root]')
        ?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }),
        ),
    );
    expect(load).toHaveBeenCalledOnce();
  });

  it('loads older turns on an upward touch-scroll attempt without a scroll event', () => {
    const load = vi.fn();
    render({ hasOlderHistory: true, onLoadOlderHistory: load });
    const scroller = container.querySelector('[data-chat-thread-root]');
    for (const [type, clientY] of [
      ['touchstart', 100],
      ['touchmove', 150],
    ] as const) {
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, 'touches', { value: [{ clientY }] });
      act(() => scroller?.dispatchEvent(event));
    }
    expect(load).toHaveBeenCalledOnce();
  });
  it('keeps the empty disclaimer separate from hydration and generation', () => {
    render({ messages: [] });
    expect(
      container.querySelector('[data-chat-empty-disclaimer]'),
    ).not.toBeNull();
    render({ messages: [], isHistoryLoading: true });
    expect(container.querySelector('[data-chat-empty-disclaimer]')).toBeNull();
    expect(container.querySelector('[data-loading]')).not.toBeNull();
  });
});
