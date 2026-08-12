// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatSessionProvider } from '@/hooks/useChatSession';

import { ChatInput } from './ChatInput';

const chatState = {
  pendingAttachments: [],
  selectionAttachment: null,
  addPendingAttachment: vi.fn(),
  removePendingAttachment: vi.fn(),
};

const panelState: {
  focusChatInputRequest: { threadId: string; nonce: number } | null;
} = {
  focusChatInputRequest: null,
};

vi.mock('@/store/canvasStore', () => ({
  default: (selector: (state: { canvasId: null }) => unknown) =>
    selector({ canvasId: null }),
}));

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
vi.mock('./SelectedNodeRefs', () => ({ SourceCount: () => null }));
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
});
