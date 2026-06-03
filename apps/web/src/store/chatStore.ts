import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { createId } from '@sediment/shared';

import type { ChatMessage } from './chatTypes';
import type {
  AgentBinding,
  AgentMode,
  AssistantToolPart,
  ChatAttachment,
} from '@sediment/shared';

/**
 * Default binding for any newly opened canvas / cleared thread.
 * v1: built-in Huabu agent. External bindings only appear when the
 * user explicitly picks an agent in the NewChatMenu.
 */
const DEFAULT_BINDING: AgentBinding = { kind: 'internal' };

export interface ChatState {
  /**
   * Per-thread message lists. Indexed by threadId, in-memory only.
   * Each entry is the live message array for that thread; a missing
   * key means "not yet hydrated from history". The user-visible chat
   * panel is always `messagesByThread[threadId]` (see
   * `selectCurrentMessages`).
   *
   * Modelled per-thread (instead of a single `messages` array + stash
   * pattern) so concurrent agent runs across multiple threads — e.g.
   * canvas chat plus one or more question-node threads — each write
   * to their own list without colliding when the user navigates away
   * mid-stream.
   */
  messagesByThread: Record<string, ChatMessage[]>;
  /** Current thread identifier for the active canvas. */
  threadId: string;
  /**
   * Set of threadIds whose history has been fetched at least once.
   * Drives the `useChatHistory` effect — threads not in this set get
   * a `fetchHistory` round-trip when they become current.
   */
  historyLoadedThreads: Set<string>;
  /** Last agent mode — persisted to determine which checkpoint to load on refresh */
  lastAction: AgentMode;
  /** Map of canvasId → threadId, persisted so each canvas keeps its own thread. */
  threadMap: Record<string, string>;

  /**
   * Active thread → agent binding. 1 thread = 1 binding for its entire
   * lifetime; the only way to change it is to start a new thread
   * (`clearMessages`).
   */
  agentBinding: AgentBinding;
  /**
   * Map of canvasId → AgentBinding, persisted so each canvas keeps its
   * own binding across reloads. Source of truth on the client; the
   * server is stateless about thread bindings and reads the binding
   * from each request body.
   */
  bindingMap: Record<string, AgentBinding>;

  /**
   * When set, the chat panel is viewing a question node's conversation thread
   * in read/replay mode instead of the normal canvas chat.
   */
  viewingQuestionThread: { nodeId: string; threadId: string } | null;

  /**
   * When set, the chat panel is inspecting a single sketch cluster
   * (showing its synthesized tool-call style trace). Mutually exclusive
   * with `viewingQuestionThread`.
   */
  viewingSketchCluster: { clusterId: string } | null;

  /**
   * @internal Saved canvas thread ID so `closeQuestionThread` knows
   * which thread to restore. Messages are *not* stashed — they live in
   * `messagesByThread` keyed by their own threadId and survive the
   * round-trip naturally.
   */
  _savedCanvasThreadId?: string;
  /** @internal Saved canvas agent binding while viewing a question thread. */
  _savedCanvasBinding?: AgentBinding;

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

  /**
   * Set of threadIds with an in-flight agent stream. Multiple threads
   * may stream concurrently (e.g. canvas chat + a question node's
   * thread), so the UI must read loading state per thread rather than
   * from a single hook-local flag. In-memory only — never persisted.
   */
  loadingThreadIds: Set<string>;

  // Actions
  /**
   * Append a message to a specific thread's list. All writers take a
   * threadId explicitly: SSE callbacks pass the owner-thread captured
   * at send time, UI handlers pass the currently-visible thread.
   */
  addMessage: (threadId: string, message: ChatMessage) => void;
  updateMessage: (
    threadId: string,
    id: string,
    updater: (msg: ChatMessage) => ChatMessage,
  ) => void;
  /**
   * Upsert a `kind:'tool'` segment on an assistant message identified
   * by `messageId`, matched by `toolCallId`. The `factory` receives
   * the prior part (or `undefined` for a fresh insertion) and must
   * return the full part with the same `toolCallId`. Used by the SSE
   * handler to merge `tool_call_update` into a previously appended
   * `tool_call`, and by the legacy `tool_start` → `tool_result` adapter
   * to fold those events into the same assistant turn.
   *
   * No-op if `messageId` does not resolve to an assistant message.
   */
  upsertAssistantToolPart: (
    threadId: string,
    messageId: string,
    toolCallId: string,
    factory: (existing: AssistantToolPart | undefined) => AssistantToolPart,
  ) => void;
  /** Replace the entire message list for a thread. */
  setMessages: (threadId: string, messages: ChatMessage[]) => void;
  /** Mark a thread as history-loaded so `useChatHistory` skips it. */
  setHistoryLoaded: (threadId: string, loaded: boolean) => void;
  setLastAction: (action: AgentMode) => void;
  /**
   * Reset the current thread: clear messages, mint a fresh threadId,
   * and reset the binding. By default the new thread starts on the
   * built-in agent (`DEFAULT_BINDING`); pass `options.binding` to start
   * the new thread already bound to a specific agent. The combined form
   * lets the UI offer a single-click "new chat with <agent>" affordance
   * without a flash of internal-binding state between two separate
   * store updates.
   */
  clearMessages: (
    canvasId?: string,
    options?: { binding?: AgentBinding },
  ) => void;

  /**
   * Change the agent binding for the current thread. Pass `canvasId` to
   * also persist the choice to `bindingMap` so it is remembered the
   * next time the user opens this canvas. UI guards against calling
   * this while a thread has any messages (1 thread = 1 binding).
   */
  setAgentBinding: (binding: AgentBinding, canvasId?: string) => void;

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

  /**
   * Open a question node's thread in the chat panel (replay mode).
   * Pass the question's `binding` so the ChatInput's mode selector
   * surfaces the agent that actually answered this question — the
   * canvas-level binding is stashed and restored on close.
   */
  openQuestionThread: (
    nodeId: string,
    threadId: string,
    binding?: AgentBinding,
  ) => void;
  /** Close question thread replay and return to normal canvas chat. */
  closeQuestionThread: () => void;

  /** Open the inspector view for a single sketch cluster. */
  openSketchCluster: (clusterId: string) => void;
  /** Close the sketch cluster inspector view. */
  closeSketchCluster: () => void;

  /** Mark / unmark a thread as having an active streaming run. */
  setThreadLoading: (threadId: string, loading: boolean) => void;

  /**
   * Drop cached message lists for threads that aren't currently pinned.
   * A thread is "pinned" if it is:
   *   - the currently-visible `threadId`,
   *   - in `loadingThreadIds` (mid-stream),
   *   - or `_savedCanvasThreadId` (about to be restored on
   *     `closeQuestionThread`).
   *
   * Triggered at user-visible thread-switch boundaries (open/close
   * question thread, switch canvas, clear). Writes stay hot — eviction
   * never runs on the message-write path. Evicted threads will be
   * refetched by `useChatHistory` the next time they become visible.
   */
  evictInactiveThreads: (maxKeep?: number) => void;
}

/**
 * Soft upper bound on cached thread message lists. Picked to comfortably
 * cover the realistic working set (1 canvas chat + a handful of recently
 * opened question threads) without holding on to dead history forever.
 * Crossing the threshold drops *all* non-pinned entries at once — simple
 * and predictable; refetch on re-visit is cheap.
 */
const MAX_CACHED_THREADS = 10;

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      messagesByThread: {},
      threadId: createId('thread'),
      historyLoadedThreads: new Set<string>(),
      lastAction: 'ask',
      threadMap: {},
      agentBinding: DEFAULT_BINDING,
      bindingMap: {},
      pendingAttachments: [],
      selectionAttachment: null,
      viewingQuestionThread: null,
      viewingSketchCluster: null,
      loadingThreadIds: new Set<string>(),

      addMessage: (threadId, message) =>
        set((state) => ({
          messagesByThread: {
            ...state.messagesByThread,
            [threadId]: [...(state.messagesByThread[threadId] ?? []), message],
          },
        })),

      updateMessage: (threadId, id, updater) =>
        set((state) => {
          const list = state.messagesByThread[threadId];
          if (!list) return {};
          return {
            messagesByThread: {
              ...state.messagesByThread,
              [threadId]: list.map((m) => (m.id === id ? updater(m) : m)),
            },
          };
        }),

      upsertAssistantToolPart: (threadId, messageId, toolCallId, factory) =>
        set((state) => {
          const list = state.messagesByThread[threadId];
          if (!list) return {};
          return {
            messagesByThread: {
              ...state.messagesByThread,
              [threadId]: list.map((m) => {
                if (m.id !== messageId || m.role !== 'assistant') return m;
                let found = false;
                const segments = m.segments.map((seg) => {
                  if (seg.kind === 'tool' && seg.toolCallId === toolCallId) {
                    found = true;
                    return factory(seg);
                  }
                  return seg;
                });
                // If no existing tool part, append a new one. Callers
                // can rely on the inserted part's `kind`/`toolCallId`
                // being exactly what `factory(undefined)` produced.
                if (!found) segments.push(factory(undefined));
                return { ...m, segments };
              }),
            },
          };
        }),

      setMessages: (threadId, messages) =>
        set((state) => ({
          messagesByThread: {
            ...state.messagesByThread,
            [threadId]: messages,
          },
        })),

      setHistoryLoaded: (threadId, loaded) =>
        set((state) => {
          const isAlreadyLoaded = state.historyLoadedThreads.has(threadId);
          if (isAlreadyLoaded === loaded) return {};
          const next = new Set(state.historyLoadedThreads);
          if (loaded) next.add(threadId);
          else next.delete(threadId);
          return { historyLoadedThreads: next };
        }),

      setLastAction: (action) => set({ lastAction: action }),

      clearMessages: (canvasId, options) => {
        const {
          threadMap,
          bindingMap,
          messagesByThread,
          historyLoadedThreads,
        } = get();
        const newThreadId = createId('thread');
        const initialBinding = options?.binding ?? DEFAULT_BINDING;
        const updatedThreads = canvasId
          ? { ...threadMap, [canvasId]: newThreadId }
          : { ...threadMap };
        // New thread → caller-specified binding (defaults to built-in).
        // Persist the choice for this canvas so reloads agree with the
        // in-memory state.
        const updatedBindings = canvasId
          ? { ...bindingMap, [canvasId]: initialBinding }
          : { ...bindingMap };
        // Seed an empty messages list for the new thread and mark it
        // history-loaded so the history hook doesn't try to fetch.
        const nextLoaded = new Set(historyLoadedThreads);
        nextLoaded.add(newThreadId);
        set({
          messagesByThread: { ...messagesByThread, [newThreadId]: [] },
          threadId: newThreadId,
          historyLoadedThreads: nextLoaded,
          lastAction: 'ask',
          pendingAttachments: [],
          selectionAttachment: null,
          threadMap: updatedThreads,
          agentBinding: initialBinding,
          bindingMap: updatedBindings,
        });
        get().evictInactiveThreads();
      },

      setAgentBinding: (binding, canvasId) => {
        const { bindingMap } = get();
        set({
          agentBinding: binding,
          bindingMap: canvasId
            ? { ...bindingMap, [canvasId]: binding }
            : bindingMap,
        });
      },

      switchToCanvas: (canvasId: string) => {
        const { threadMap, bindingMap } = get();
        let tid = threadMap[canvasId];
        if (!tid) {
          tid = createId('thread');
        }
        const binding = bindingMap[canvasId] ?? DEFAULT_BINDING;
        set({
          threadId: tid,
          // Don't touch messagesByThread — if this canvas's thread is
          // already cached, the user sees it instantly; otherwise the
          // history hook will populate it from the server.
          pendingAttachments: [],
          selectionAttachment: null,
          threadMap: { ...threadMap, [canvasId]: tid },
          agentBinding: binding,
          bindingMap: bindingMap[canvasId]
            ? bindingMap
            : { ...bindingMap, [canvasId]: binding },
        });
        get().evictInactiveThreads();
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

      openQuestionThread: (nodeId, threadId, binding) => {
        const {
          threadId: currentThreadId,
          agentBinding: currentBinding,
          viewingQuestionThread: currentViewing,
        } = get();

        // Already viewing this exact question thread — nothing to do.
        if (currentViewing?.threadId === threadId) return;

        // If we're already viewing a different question thread, don't
        // overwrite the saved canvas binding — keep the original.
        const isAlreadyViewing = currentViewing !== null;

        // Question-thread binding: prefer the binding the question was
        // actually run with; fall back to the default internal agent
        // for legacy nodes that pre-date `data.agentBinding`.
        const nextBinding: AgentBinding = binding ?? DEFAULT_BINDING;

        // No need to stash messages — they live in `messagesByThread`
        // keyed by their own threadId and survive the navigation. The
        // history hook handles first-time hydration of the question
        // thread; subsequent visits hit the cache.
        set({
          viewingQuestionThread: { nodeId, threadId },
          threadId: threadId,
          agentBinding: nextBinding,
          ...(!isAlreadyViewing && {
            _savedCanvasThreadId: currentThreadId,
            _savedCanvasBinding: currentBinding,
          }),
        });
        get().evictInactiveThreads();
      },

      closeQuestionThread: () => {
        const state = get();
        set({
          viewingQuestionThread: null,
          threadId: state._savedCanvasThreadId ?? state.threadId,
          agentBinding: state._savedCanvasBinding ?? state.agentBinding,
          _savedCanvasThreadId: undefined,
          _savedCanvasBinding: undefined,
        });
        get().evictInactiveThreads();
      },

      openSketchCluster: (clusterId) => {
        // Sketch inspector is a pure overlay over the existing chat
        // state — no thread switch needed. We just flip a flag and the
        // ChatPanel renders synthesized messages from the intent
        // store. Closing any active question thread first keeps the
        // two modes mutually exclusive.
        const state = get();
        if (state.viewingQuestionThread) {
          set({
            viewingQuestionThread: null,
            threadId: state._savedCanvasThreadId ?? state.threadId,
            agentBinding: state._savedCanvasBinding ?? state.agentBinding,
            _savedCanvasThreadId: undefined,
            _savedCanvasBinding: undefined,
          });
        }
        set({ viewingSketchCluster: { clusterId } });
      },

      closeSketchCluster: () => {
        set({ viewingSketchCluster: null });
      },

      setThreadLoading: (threadId, loading) =>
        set((state) => {
          const isAlreadyLoading = state.loadingThreadIds.has(threadId);
          if (isAlreadyLoading === loading) return {};
          const next = new Set(state.loadingThreadIds);
          if (loading) next.add(threadId);
          else next.delete(threadId);
          return { loadingThreadIds: next };
        }),

      evictInactiveThreads: (maxKeep = MAX_CACHED_THREADS) =>
        set((state) => {
          const cached = Object.keys(state.messagesByThread);
          if (cached.length <= maxKeep) return {};

          const pinned = new Set<string>([
            state.threadId,
            ...state.loadingThreadIds,
          ]);
          if (state._savedCanvasThreadId) {
            pinned.add(state._savedCanvasThreadId);
          }

          const evictable = cached.filter((tid) => !pinned.has(tid));
          if (evictable.length === 0) return {};

          const nextMessages = { ...state.messagesByThread };
          const nextLoaded = new Set(state.historyLoadedThreads);
          for (const tid of evictable) {
            delete nextMessages[tid];
            nextLoaded.delete(tid);
          }
          return {
            messagesByThread: nextMessages,
            historyLoadedThreads: nextLoaded,
          };
        }),
    }),
    {
      name: 'sediment-chat',
      partialize: (state) => ({
        threadMap: state.threadMap,
        threadId: state.threadId,
        lastAction: state.lastAction,
        bindingMap: state.bindingMap,
      }),
    },
  ),
);

/** Stable empty array so selectors that miss the cache don't trigger renders. */
const EMPTY_MESSAGES: ChatMessage[] = [];

/**
 * Read the currently-visible thread's message list. Returns a stable
 * empty array reference when the thread hasn't been hydrated yet.
 */
export const selectCurrentMessages = (state: ChatState): ChatMessage[] =>
  state.messagesByThread[state.threadId] ?? EMPTY_MESSAGES;

/** True if the currently-visible thread has been hydrated from the server. */
export const selectCurrentHistoryLoaded = (state: ChatState): boolean =>
  state.historyLoadedThreads.has(state.threadId);

/** True if the currently-visible thread has an active streaming run. */
export const selectCurrentIsLoading = (state: ChatState): boolean =>
  state.loadingThreadIds.has(state.threadId);
