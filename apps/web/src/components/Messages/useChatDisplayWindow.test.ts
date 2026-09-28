// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  chatDisplayTurns,
  recentDisplayTurnIndex,
} from './useChatDisplayWindow';

import type { ChatMessage } from '@/store/chatTypes';

describe('chat display turns', () => {
  it('keeps hydrated continuation user messages in one server display turn', () => {
    const messages: ChatMessage[] = [
      { id: 'a', historyTurnId: 't1', role: 'user', content: 'Hello' },
      { id: 'b', historyTurnId: 't1', role: 'assistant', segments: [] },
      { id: 'c', historyTurnId: 't1', role: 'user', content: 'Continuation' },
      { id: 'd', historyTurnId: 't2', role: 'user', content: 'Next' },
      { id: 'e', role: 'assistant', segments: [] },
      { id: 'f', role: 'status', status: 'interrupted' },
      { id: 'g', role: 'user', content: 'New live input' },
    ];
    expect(chatDisplayTurns(messages)).toEqual([
      { key: 't1', start: 0 },
      { key: 't2', start: 3 },
      { key: 'g', start: 6 },
    ]);
    expect(
      recentDisplayTurnIndex(chatDisplayTurns(messages), messages, 2),
    ).toBe(1);
  });

  it('preserves orphan leading content and an active server turn', () => {
    const messages: ChatMessage[] = [
      { id: 'a', role: 'assistant', segments: [] },
      { id: 'b', role: 'user', content: 'Active', historyTurnActive: true },
      { id: 'c', role: 'assistant', segments: [] },
      { id: 'd', role: 'user', content: 'Next' },
    ];
    expect(
      recentDisplayTurnIndex(chatDisplayTurns(messages), messages, 1),
    ).toBe(1);
    expect(chatDisplayTurns([])).toEqual([]);
  });
});
