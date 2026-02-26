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

  // Actions
  addMessage: (message: ChatMessage) => void;
  updateMessage: (
    id: string,
    updater: (msg: ChatMessage) => ChatMessage,
  ) => void;
  setMessages: (messages: ChatMessage[]) => void;
  setHistoryLoaded: (loaded: boolean) => void;
  clearMessages: () => void;
}

export const useChatStore = create<ChatState>()(
  persist(
    (set) => ({
      messages: [],
      threadId: createId('thread'),
      isHistoryLoaded: false,

      addMessage: (message) =>
        set((state) => ({ messages: [...state.messages, message] })),

      updateMessage: (id, updater) =>
        set((state) => ({
          messages: state.messages.map((m) => (m.id === id ? updater(m) : m)),
        })),

      setMessages: (messages) => set({ messages }),

      setHistoryLoaded: (loaded) => set({ isHistoryLoaded: loaded }),

      clearMessages: () =>
        // isHistoryLoaded stays true for the new thread — it has no server-side
        // history so there is no need to make an API call.
        set({
          messages: [],
          threadId: createId('thread'),
          isHistoryLoaded: true,
        }),
    }),
    {
      name: 'sediment-chat',
      // Only persist the thread ID — messages are loaded from the server on mount.
      partialize: (state) => ({ threadId: state.threadId }),
    },
  ),
);
