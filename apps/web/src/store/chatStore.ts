import { createId } from '@sediment/shared';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { ChatMessage } from '../components/Messages/types';

interface ChatState {
  messages: ChatMessage[];
  threadId: string;

  // Actions
  addMessage: (message: ChatMessage) => void;
  updateMessage: (
    id: string,
    updater: (msg: ChatMessage) => ChatMessage,
  ) => void;
  clearMessages: () => void;
}

export const useChatStore = create<ChatState>()(
  persist(
    (set) => ({
      messages: [],
      threadId: createId('thread'),

      addMessage: (message) =>
        set((state) => ({ messages: [...state.messages, message] })),

      updateMessage: (id, updater) =>
        set((state) => ({
          messages: state.messages.map((m) => (m.id === id ? updater(m) : m)),
        })),

      clearMessages: () => set({ messages: [], threadId: createId('thread') }),
    }),
    {
      name: 'sediment-chat',
      // Normalise any "running" research messages to "completed" on rehydration
      // so stale in-progress states are never shown after a page refresh.
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        state.messages = state.messages.map((m) =>
          m.role === 'research' && m.status === 'running'
            ? { ...m, status: 'completed' as const }
            : m,
        );
      },
    },
  ),
);
