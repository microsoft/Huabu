// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { ChatMessage } from './chatTypes';

/** Page bodies live only in thread.messages; this directory survives eviction. */
export interface ChatHistoryPage {
  before?: string;
  limit: number;
  messageIds: string[];
  loaded: boolean;
}

export const MAX_HISTORY_PAGES = 5;

export function isProtectedHistoryMessage(message: ChatMessage): boolean {
  return (
    !message.historyTurnId ||
    message.historyTurnActive === true ||
    (message.role === 'assistant' &&
      message.segments.some(
        (part) => part.kind === 'permission' && !part.resolution,
      ))
  );
}

export function historyMessageIds(
  pages: readonly ChatHistoryPage[],
  messages: readonly ChatMessage[],
): string[] {
  const ids = new Set(pages.flatMap((page) => page.messageIds));
  for (const message of messages) ids.add(message.id);
  return [...ids];
}

/** Keep the viewport and the mutable newest page, never evict live interactions. */
export function trimHistoryPages(
  pages: ChatHistoryPage[],
  messages: ChatMessage[],
  visibleIds: readonly string[],
): { historyPages: ChatHistoryPage[]; messages: ChatMessage[] } {
  const visible = new Set(visibleIds);
  const protectedIds = new Set(
    messages.filter(isProtectedHistoryMessage).map((message) => message.id),
  );
  const visiblePage = pages.findIndex((page) =>
    page.messageIds.some((id) => visible.has(id)),
  );
  const center = visiblePage >= 0 ? visiblePage : pages.length - 1;
  const keep = new Set(
    pages.flatMap((page, index) =>
      page.before === undefined ||
      page.messageIds.some((id) => visible.has(id) || protectedIds.has(id))
        ? [index]
        : [],
    ),
  );
  pages
    .map((page, index) => ({ page, index }))
    .filter(({ page }) => page.loaded)
    .sort((a, b) => Math.abs(a.index - center) - Math.abs(b.index - center))
    .forEach(({ index }) => {
      if (keep.size < MAX_HISTORY_PAGES) keep.add(index);
    });
  const evicted = new Set<string>();
  const historyPages = pages.map((page, index) => {
    if (!page.loaded || keep.has(index)) return page;
    page.messageIds.forEach((id) => evicted.add(id));
    return { ...page, loaded: false };
  });
  // A turn can overlap a refreshed page boundary.
  historyPages
    .filter((page) => page.loaded)
    .forEach((page) => page.messageIds.forEach((id) => evicted.delete(id)));
  return {
    historyPages,
    messages: messages.filter((message) => !evicted.has(message.id)),
  };
}
