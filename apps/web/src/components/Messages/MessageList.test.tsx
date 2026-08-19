// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MessageList } from './MessageList';
import { rememberMessageListScrollPosition } from './messageListScroll';

vi.mock('./UserMessage', () => ({
  UserMessage: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock('./AIMessage', () => ({ AIMessage: () => <div /> }));
vi.mock('./StatusMessage', () => ({ StatusMessage: () => <div /> }));
vi.mock('../Common/Loading', () => ({ Loading: () => null }));
vi.mock('../Common/ThinkingIndicator', () => ({
  ThinkingIndicator: () => null,
}));

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

describe('MessageList opening position', () => {
  it('restores a saved position and offers new messages without auto-scrolling', async () => {
    const viewKey = 'canvas-1:thread-1';
    rememberMessageListScrollPosition(viewKey, 240);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    const scrollHeight = vi
      .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
      .mockReturnValue(1_000);
    const clientHeight = vi
      .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
      .mockReturnValue(200);

    try {
      await act(async () => {
        root?.render(
          <MessageList
            messages={[]}
            isLoading={false}
            viewKey={viewKey}
            openPosition="last-user"
            openPositionRequestNonce={1}
          />,
        );
      });

      const container = host.querySelector<HTMLElement>(
        '[data-chat-thread-root]',
      );
      expect(container?.scrollTop).toBe(240);
      expect(host.textContent).toContain('New message');
    } finally {
      scrollHeight.mockRestore();
      clientHeight.mockRestore();
    }
  });
});
