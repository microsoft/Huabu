import { createId } from '@sediment/shared';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { ChatMessage } from '../components/Messages/types';
import type { AgentMode, ChatAttachment } from '@sediment/shared';

interface ChatState {
  /** In-memory message list — not persisted to localStorage. */
  messages: ChatMessage[];
  /** Current thread identifier for the active canvas. */
  threadId: string;
  /** True once history has been fetched from the server for the current threadId. */
  isHistoryLoaded: boolean;
  /** Last agent mode — persisted to determine which checkpoint to load on refresh */
  lastAction: AgentMode;
  /** Map of canvasId → threadId, persisted so each canvas keeps its own thread. */
  threadMap: Record<string, string>;

  /**
   * When set, the chat panel is viewing a prompt node's conversation thread
   * in read/replay mode instead of the normal canvas chat.
   */
  viewingPromptThread: { nodeId: string; threadId: string } | null;

  /**
   * Staged attachments waiting to be sent with the next message.
   * Populated by external actions (e.g. PDF capture "Send to Chat") and
   * consumed when the user submits a chat message.
   */
  pendingAttachments: ChatAttachment[];

  /**
   * A text-selection-based attachment auto-managed by ExpandedNodePanel.
   * Stored separately from pendingAttachments so it can be independently
   * set/cleared without index gymnastics or magic marker strings.
   */
  selectionAttachment: ChatAttachment | null;

  // Actions
  addMessage: (message: ChatMessage) => void;
  updateMessage: (
    id: string,
    updater: (msg: ChatMessage) => ChatMessage,
  ) => void;
  setMessages: (messages: ChatMessage[]) => void;
  setHistoryLoaded: (loaded: boolean) => void;
  setLastAction: (action: AgentMode) => void;
  clearMessages: (canvasId?: string) => void;

  /** Switch to a canvas — loads or creates its threadId, resets in-memory messages. */
  switchToCanvas: (canvasId: string) => void;

  /** Stage an attachment (e.g. from PDF capture) to be sent with the next chat message. */
  addPendingAttachment: (attachment: ChatAttachment) => void;
  /** Remove a staged attachment by index. */
  removePendingAttachment: (index: number) => void;
  /** Clear all staged attachments (called after message is sent). */
  clearPendingAttachments: () => void;

  /** Set/replace the text-selection-based attachment (auto-managed by ExpandedNodePanel). */
  setSelectionAttachment: (attachment: ChatAttachment | null) => void;

  /** Open a prompt node's thread in the chat panel (replay mode). */
  openPromptThread: (nodeId: string, threadId: string) => void;
  /** Close prompt thread replay and return to normal canvas chat. */
  closePromptThread: () => void;
}

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      messages: [],
      threadId: createId('thread'),
      isHistoryLoaded: false,
      lastAction: 'ask',
      threadMap: {},
      pendingAttachments: [],
      selectionAttachment: null,
      viewingPromptThread: null,

      addMessage: (message) =>
        set((state) => ({ messages: [...state.messages, message] })),

      updateMessage: (id, updater) =>
        set((state) => ({
          messages: state.messages.map((m) => (m.id === id ? updater(m) : m)),
        })),

      setMessages: (messages) => set({ messages }),

      setHistoryLoaded: (loaded) => set({ isHistoryLoaded: loaded }),

      setLastAction: (action) => set({ lastAction: action }),

      clearMessages: (canvasId?: string) => {
        const { threadMap } = get();
        const newThreadId = createId('thread');
        const updatedMap = canvasId
          ? { ...threadMap, [canvasId]: newThreadId }
          : { ...threadMap };
        set({
          messages: [],
          threadId: newThreadId,
          isHistoryLoaded: true,
          lastAction: 'ask',
          pendingAttachments: [],
          selectionAttachment: null,
          threadMap: updatedMap,
        });
      },

      switchToCanvas: (canvasId: string) => {
        const { threadMap } = get();
        let tid = threadMap[canvasId];
        if (!tid) {
          tid = createId('thread');
        }
        set({
          threadId: tid,
          messages: [],
          isHistoryLoaded: false,
          pendingAttachments: [],
          selectionAttachment: null,
          threadMap: { ...threadMap, [canvasId]: tid },
        });
      },

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

      setSelectionAttachment: (attachment) =>
        set({ selectionAttachment: attachment }),

      openPromptThread: (nodeId, threadId) => {
        const {
          threadId: currentThreadId,
          messages: currentMessages,
          viewingPromptThread: currentViewing,
        } = get();

        // Already viewing this exact prompt thread — nothing to do.
        if (currentViewing?.threadId === threadId) return;

        // If we're already viewing a different prompt thread, don't
        // overwrite the stash — keep the original canvas thread.
        const isAlreadyViewing = currentViewing !== null;

        set({
          viewingPromptThread: { nodeId, threadId },
          // Swap to the prompt thread — history hook will refetch
          threadId: threadId,
          messages: [],
          isHistoryLoaded: false,
          // Stash the previous thread ID so we can restore on close
          ...(!isAlreadyViewing && {
            _stashedThreadId: currentThreadId,
            _stashedMessages: currentMessages,
          }),
        });
      },

      closePromptThread: () => {
        const state = get() as ChatState & {
          _stashedThreadId?: string;
          _stashedMessages?: ChatMessage[];
        };
        set({
          viewingPromptThread: null,
          threadId: state._stashedThreadId ?? state.threadId,
          messages: state._stashedMessages ?? [],
          isHistoryLoaded: (state._stashedMessages ?? []).length > 0,
        });
      },
    }),
    {
      name: 'sediment-chat',
      partialize: (state) => ({
        threadMap: state.threadMap,
        threadId: state.threadId,
        lastAction: state.lastAction,
      }),
    },
  ),
);
