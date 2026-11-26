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
export const HISTORY_PAGE_TURNS = 3;

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

/**
 * Carry the messages the page sent and has no turn for from `current` into
 * `next`, a transcript rebuilt from server history. Each keeps its place:
 * directly after the last persisted turn that preceded it, or first when that
 * turn is no longer loaded. One whose delivery is still being confirmed gives
 * way to a newer turn in history.
 */
export function keepUnsentMessages(
  current: readonly ChatMessage[],
  next: ChatMessage[],
): ChatMessage[] {
  const present = new Set(next.map((message) => message.id));
  const kept: { after?: string; message: ChatMessage }[] = [];
  let lastTurn: string | undefined;
  for (const message of current) {
    if (message.historyTurnId) lastTurn = message.historyTurnId;
    if (message.role === 'user' && message.delivery && !present.has(message.id))
      kept.push({ after: lastTurn, message });
  }
  if (kept.length === 0) return next;
  const result = [...next];
  // Later ones go in first so that earlier ones end up ahead of them.
  for (const { after, message } of kept.reverse()) {
    let anchor = result.length - 1;
    while (
      anchor >= 0 &&
      (after === undefined || result[anchor]?.historyTurnId !== after)
    )
      anchor -= 1;
    // A send still being confirmed that history now follows with a newer turn
    // is taken to be that turn: showing both would repeat the message for as
    // long as its answer streams.
    if (
      message.role === 'user' &&
      message.delivery === 'confirming' &&
      result.slice(anchor + 1).some((later) => later.historyTurnId)
    )
      continue;
    result.splice(anchor + 1, 0, message);
  }
  return result;
}

export function historyMessageIds(
  pages: readonly ChatHistoryPage[],
  messages: readonly ChatMessage[],
): string[] {
  const ids = [...new Set(pages.flatMap((page) => page.messageIds))];
  const known = new Set(ids);
  // A message outside every page is local. It sits where the transcript has
  // it: after the message before it, or ahead of the first one that follows.
  let previous: string | undefined;
  let leading: string[] = [];
  for (const message of messages) {
    if (known.has(message.id)) {
      if (leading.length > 0) {
        ids.splice(ids.indexOf(message.id), 0, ...leading);
        leading = [];
      }
    } else {
      // Still ahead of every known message while the one before it is too.
      const at = previous === undefined ? -1 : ids.indexOf(previous);
      if (at < 0) leading.push(message.id);
      else ids.splice(at + 1, 0, message.id);
    }
    known.add(message.id);
    previous = message.id;
  }
  return [...ids, ...leading];
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
