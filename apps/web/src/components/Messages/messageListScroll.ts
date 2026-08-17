// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export type MessageListOpenPosition = 'last-user' | 'bottom';
export type MessageListPreferredPosition = 'last-user' | 'bottom';

const scrollTopByViewKey = new Map<string, number>();

export function rememberMessageListScrollPosition(
  viewKey: string | undefined,
  scrollTop: number,
): void {
  if (!viewKey || !Number.isFinite(scrollTop)) return;
  scrollTopByViewKey.set(viewKey, Math.max(0, scrollTop));
}

export function restoreMessageListScrollPosition(
  container: HTMLElement,
  viewKey: string | undefined,
): boolean {
  if (!viewKey) return false;
  const scrollTop = scrollTopByViewKey.get(viewKey);
  if (scrollTop === undefined) return false;
  container.scrollTop = scrollTop;
  return true;
}

export function forgetMessageListScrollPosition(
  viewKey: string | undefined,
): void {
  if (!viewKey) return;
  scrollTopByViewKey.delete(viewKey);
}

/** Position an opened conversation without scrolling any page ancestors. */
export function positionMessageListOnOpen(
  container: HTMLElement,
  preferredPosition: MessageListPreferredPosition,
): MessageListOpenPosition {
  if (preferredPosition === 'last-user') {
    const userMessages = container.querySelectorAll<HTMLElement>(
      '[data-chat-user-message]',
    );
    const lastUserMessage = userMessages.item(userMessages.length - 1);
    if (lastUserMessage) {
      const containerRect = container.getBoundingClientRect();
      const messageRect = lastUserMessage.getBoundingClientRect();
      container.scrollTop += messageRect.top - containerRect.top;
      return 'last-user';
    }
  }

  container.scrollTop = container.scrollHeight;
  return 'bottom';
}
