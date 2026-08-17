// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export type MessageListOpenPosition = 'last-user' | 'bottom';
export type MessageListPreferredPosition = 'last-user' | 'bottom';

export {
  forgetMessageListScrollPosition,
  rememberMessageListScrollPosition,
  restoreMessageListScrollPosition,
} from '@/store/previewWorkspace/scrollMemory';

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
