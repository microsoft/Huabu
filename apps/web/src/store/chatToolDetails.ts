// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { ChatMessage } from './chatTypes';

/** A summary refresh must not discard details still resident in this page. */
export function preserveLoadedToolDetails(
  incoming: ChatMessage[],
  current: readonly ChatMessage[],
): ChatMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  return incoming.map((message) => {
    const previous = byId.get(message.id);
    if (
      message.role !== 'assistant' ||
      message.historyTurnActive ||
      previous?.role !== 'assistant' ||
      previous.historyTurnActive
    )
      return message;
    return {
      ...message,
      segments: message.segments.map((part, index) => {
        const old = previous.segments[index];
        return part.kind === 'tool' &&
          part.detail?.state === 'deferred' &&
          old?.kind === 'tool' &&
          old.detail?.state === 'inline' &&
          old.detail.turnRef === part.detail.turnRef &&
          old.toolCallId === part.toolCallId
          ? old
          : part;
      }),
    };
  });
}
