// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useMemo, useState } from 'react';

import type { ChatMessage } from '@/store/chatTypes';

export interface DisplayTurn {
  key: string;
  start: number;
}

function turnAtMessageIndex(turns: DisplayTurn[], index: number): number {
  for (let turn = turns.length - 1; turn >= 0; turn--) {
    const candidate = turns[turn];
    if (candidate && candidate.start <= index) return turn;
  }
  return 0;
}

/** Server display groups include continuations; live user inputs start new groups. */
export function chatDisplayTurns(messages: ChatMessage[]): DisplayTurn[] {
  const turns: DisplayTurn[] = [];
  let historyTurnId: string | undefined;
  for (const [index, message] of messages.entries()) {
    if (
      index === 0 ||
      (message.historyTurnId
        ? message.historyTurnId !== historyTurnId
        : message.role === 'user')
    ) {
      turns.push({
        key: message.historyTurnId ?? message.id,
        start: index,
      });
    }
    if (message.historyTurnId) historyTurnId = message.historyTurnId;
    else if (message.role === 'user') historyTurnId = undefined;
  }
  return turns;
}

export function recentDisplayTurnIndex(
  turns: DisplayTurn[],
  messages: ChatMessage[],
  count: number,
): number {
  let start = Math.max(0, turns.length - count);
  const activeIndex = messages.findIndex(
    (message) => message.historyTurnActive,
  );
  if (activeIndex >= 0) {
    const activeTurn = turnAtMessageIndex(turns, activeIndex);
    start = Math.min(start, activeTurn);
  }
  return start;
}

interface WindowBoundary {
  key: string;
  index: number;
}

export function useChatDisplayWindow(
  messages: ChatMessage[],
  count: number | undefined,
  viewKey: string | undefined,
  activationId: number | undefined,
) {
  const turns = useMemo(() => chatDisplayTurns(messages), [messages]);
  const latestIndex =
    count === undefined ? 0 : recentDisplayTurnIndex(turns, messages, count);
  const boundaryAt = (index: number): WindowBoundary | null =>
    turns[index] ? { key: turns[index].key, index } : null;
  const [window, setWindow] = useState(() => ({
    viewKey,
    activationId,
    boundary: boundaryAt(latestIndex),
  }));

  let boundary = window.boundary;
  if (window.viewKey !== viewKey || window.activationId !== activationId) {
    boundary = boundaryAt(latestIndex);
    setWindow({ viewKey, activationId, boundary });
  } else if (!boundary && turns.length > 0) {
    boundary = boundaryAt(latestIndex);
    setWindow({ ...window, boundary });
  }

  const matchedIndex = turns.findIndex((turn) => turn.key === boundary?.key);
  // Hydration can replace live message IDs. Preserve the window's ordinal
  // boundary rather than treating reconciliation as a new navigation.
  const start =
    count === undefined || boundary?.index === 0
      ? 0
      : matchedIndex >= 0
        ? matchedIndex
        : Math.min(
            boundary?.index ?? latestIndex,
            Math.max(0, turns.length - 1),
          );
  const setStart = (index: number) =>
    setWindow({ viewKey, activationId, boundary: boundaryAt(index) });
  const visibleMessages = useMemo(
    () => (start === 0 ? messages : messages.slice(turns[start]?.start ?? 0)),
    [messages, start, turns],
  );

  return {
    messages: visibleMessages,
    hasCachedEarlier: start > 0,
    showEarlier: () => setStart(Math.max(0, start - (count ?? 3))),
    showAll: () => setStart(0),
    compact: () => setStart(latestIndex),
    revealMessage: (messageId: string) => {
      const index = messages.findIndex((message) => message.id === messageId);
      if (index < 0) return false;
      const turnIndex = turnAtMessageIndex(turns, index);
      if (turnIndex < start) setStart(turnIndex);
      return true;
    },
  };
}
