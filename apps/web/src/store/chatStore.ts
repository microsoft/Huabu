import { createId } from '@sediment/shared';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { ChatMessage } from '../components/Messages/types';
import type { AgentMode, ChatAttachment } from '@sediment/shared';

interface ChatState {
  /** In-memory message list — not persisted to localStorage. */
  messages: ChatMessage[];
  /** Stable thread identifier — persisted so the same conversation is resumed after refresh. */
  threadId: string;
  /** True once history has been fetched from the server for the current threadId. */
  isHistoryLoaded: boolean;
  /** Last agent mode — persisted to determine which checkpoint to load on refresh */
  lastAction: AgentMode;

  /**
   * Staged attachments waiting to be sent with the next message.
   * Populated by external actions (e.g. PDF capture "Send to Chat") and
   * consumed when the user submits a chat message.
   */
  pendingAttachments: ChatAttachment[];

  // Actions
  addMessage: (message: ChatMessage) => void;
  updateMessage: (
    id: string,
    updater: (msg: ChatMessage) => ChatMessage,
  ) => void;
  setMessages: (messages: ChatMessage[]) => void;
  setHistoryLoaded: (loaded: boolean) => void;
  setLastAction: (action: AgentMode) => void;
  clearMessages: () => void;

  /** Stage an attachment (e.g. from PDF capture) to be sent with the next chat message. */
  addPendingAttachment: (attachment: ChatAttachment) => void;
  /** Remove a staged attachment by index. */
  removePendingAttachment: (index: number) => void;
  /** Clear all staged attachments (called after message is sent). */
  clearPendingAttachments: () => void;
}

export const useChatStore = create<ChatState>()(
  persist(
    (set) => ({
      messages: [],
      threadId: createId('thread'),
      isHistoryLoaded: false,
      lastAction: 'ask',
      pendingAttachments: [],

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
          lastAction: 'ask',
          pendingAttachments: [],
        }),

      addPendingAttachment: (attachment) =>
        set((state) => ({
          pendingAttachments: [...state.pendingAttachments, attachment],
        })),

      removePendingAttachment: (index) =>
        set((state) => ({
          pendingAttachments: state.pendingAttachments.filter(
            (_, i) => i !== index,
          ),
        })),

      clearPendingAttachments: () => set({ pendingAttachments: [] }),
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
