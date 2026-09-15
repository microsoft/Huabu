// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_RECENT_CHAT_TURNS,
  MAX_RECENT_CHAT_TURNS,
  MIN_RECENT_CHAT_TURNS,
  normalizeRecentChatTurns,
  useChatPreferencesStore,
} from './chatPreferencesStore';

describe('chatPreferencesStore', () => {
  beforeEach(() => {
    useChatPreferencesStore.setState({
      recentTurnCount: DEFAULT_RECENT_CHAT_TURNS,
    });
  });

  it('normalizes missing, fractional, and out-of-range values', () => {
    expect(normalizeRecentChatTurns(undefined)).toBe(DEFAULT_RECENT_CHAT_TURNS);
    expect(normalizeRecentChatTurns(2.6)).toBe(3);
    expect(normalizeRecentChatTurns(0)).toBe(MIN_RECENT_CHAT_TURNS);
    expect(normalizeRecentChatTurns(100)).toBe(MAX_RECENT_CHAT_TURNS);
  });

  it('persists only a bounded recent-turn count', () => {
    useChatPreferencesStore.getState().setRecentTurnCount(0);
    expect(useChatPreferencesStore.getState().recentTurnCount).toBe(
      MIN_RECENT_CHAT_TURNS,
    );

    useChatPreferencesStore.getState().setRecentTurnCount(50);
    expect(useChatPreferencesStore.getState().recentTurnCount).toBe(
      MAX_RECENT_CHAT_TURNS,
    );
  });
});
