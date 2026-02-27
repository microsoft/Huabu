import { createId } from '@sediment/shared';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { ChatMessage } from '../components/Messages/types';

interface ChatState {
  /** In-memory message list — not persisted to localStorage. */
  messages: ChatMessage[];
  /** Stable thread identifier — persisted so the same conversation is resumed after refresh. */
  threadId: string;
  /** True once history has been fetched from the server for the current threadId. */
  isHistoryLoaded: boolean;
  /** Last action type - determines which checkpoint to load on refresh */
  lastAction: 'chat' | 'research';

  // Actions
  addMessage: (message: ChatMessage) => void;
  updateMessage: (
    id: string,
    updater: (msg: ChatMessage) => ChatMessage,
  ) => void;
  setMessages: (messages: ChatMessage[]) => void;
  setHistoryLoaded: (loaded: boolean) => void;
  setLastAction: (action: 'chat' | 'research') => void;
  clearMessages: () => void;
}

export const useChatStore = create<ChatState>()(
  persist(
    (set) => ({
      messages: [],
      threadId: createId('thread'),
      isHistoryLoaded: false,
      lastAction: 'chat',

      addMessage: (message) =>
        set((state) => ({ messages: [...state.messages, message] })),

      updateMessage: (id, updater) =>
        set((state) => ({
          messages: state.messages.map((m) => (m.id === id ? updater(m) : m)),
        })),

      setMessages: (messages) => set({ messages }),

      setHistoryLoaded: (loaded) => set({ isHistoryLoaded: loaded }),

      setLastAction: (action) => set({ lastAction: action }),

      clearMessages: () =>
        // isHistoryLoaded stays true for the new thread — it has no server-side
        // history so there is no need to make an API call.
        set({
          messages: [],
          threadId: createId('thread'),
          isHistoryLoaded: true,
          lastAction: 'chat',
        }),
    }),
    {
      name: 'sediment-chat',
      // Persist thread ID and last action type to determine which checkpoint to load
      partialize: (state) => ({
        threadId: state.threadId,
        lastAction: state.lastAction,
      }),
    },
  ),
);
