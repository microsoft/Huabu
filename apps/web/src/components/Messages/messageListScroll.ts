export type MessageListOpenPosition = 'permission' | 'last-user' | 'bottom';
export type MessageListPreferredPosition = 'last-user' | 'bottom';

/** Position an opened conversation without scrolling any page ancestors. */
export function positionMessageListOnOpen(
  container: HTMLElement,
  preferredPosition: MessageListPreferredPosition,
): MessageListOpenPosition {
  const permissionCard = container.querySelector<HTMLElement>(
    '[data-permission-request-id]',
  );

  if (permissionCard) {
    const containerRect = container.getBoundingClientRect();
    const cardRect = permissionCard.getBoundingClientRect();
    container.scrollTop += cardRect.bottom - containerRect.bottom;
    return 'permission';
  }

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
