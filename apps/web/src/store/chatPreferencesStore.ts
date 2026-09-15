// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const DEFAULT_RECENT_CHAT_TURNS = 3;
export const MIN_RECENT_CHAT_TURNS = 1;
export const MAX_RECENT_CHAT_TURNS = 20;

export function normalizeRecentChatTurns(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_RECENT_CHAT_TURNS;
  }
  return Math.min(
    MAX_RECENT_CHAT_TURNS,
    Math.max(MIN_RECENT_CHAT_TURNS, Math.round(value)),
  );
}

interface ChatPreferencesState {
  recentTurnCount: number;
  setRecentTurnCount: (count: number) => void;
}

export const useChatPreferencesStore = create<ChatPreferencesState>()(
  persist(
    (set) => ({
      recentTurnCount: DEFAULT_RECENT_CHAT_TURNS,
      setRecentTurnCount: (count) =>
        set({ recentTurnCount: normalizeRecentChatTurns(count) }),
    }),
    {
      name: 'huabu-chat-preferences',
      version: 1,
      migrate: (persisted) => {
        const state = persisted as Partial<ChatPreferencesState> | undefined;
        return {
          recentTurnCount: normalizeRecentChatTurns(state?.recentTurnCount),
        };
      },
      partialize: (state) => ({
        recentTurnCount: state.recentTurnCount,
      }),
    },
  ),
);
