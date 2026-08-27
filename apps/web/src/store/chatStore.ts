// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { createId } from '@huabu/shared';

import type { ChatMessage } from './chatTypes';
import type {
  AgentBinding,
  AgentMode,
  AssistantToolPart,
  ChatAttachment,
} from '@huabu/shared';

/**
 * Default binding for any newly opened canvas / cleared thread.
 * External bindings only appear when the user explicitly selects an agent.
 */
const DEFAULT_BINDING: AgentBinding = { kind: 'internal' };
const DEFAULT_ACTION: AgentMode = 'operate';

function defaultActionForBinding(binding: AgentBinding): AgentMode {
  return binding.kind === 'external' ? 'ask' : DEFAULT_ACTION;
}

/**
 * Everything cached for one conversation thread.
 *
 * Held as one complete object per thread rather than as parallel maps so a
 * thread is created, migrated, and evicted atomically. Parallel maps could
 * drift — messages present with the history flag already cleared, say — and
 * every such combination is a state nobody designed.
 */
export interface ChatThreadState {
  messages: ChatMessage[];
  /** Composer draft; '' means an empty composer. */
  draft: string;
  /** Whether history has been fetched from the server at least once. */
  historyLoaded: boolean;
  /** Whether an agent run is streaming into this thread right now. */
  isStreaming: boolean;
  /** Last compose mode selected for this thread. */
  lastAction: AgentMode;
  /**
   * The agent this thread is bound to. 1 thread = 1 binding for its entire
   * lifetime; the only way to change it is to start a new thread.
   */
  binding: AgentBinding;
  /**
   * Built-in per-thread capability selection. `null` means "no override".
   * Read at send time so a model picked before the first message is carried
   * on the request. Lives on the thread, so a selection made in one Chat can
   * never be applied to another thread's request.
   */
  settings: { modelId: string | null; reasoningEffort: string | null };
  /**
   * Attachments staged for this thread's next message — PDF captures, pasted
   * files, dropped images. Thread-local so staging something in one Chat
   * cannot ride along on a different Chat's send.
   */
  pendingAttachments: ChatAttachment[];
}

export interface ChatState {
  /**
   * Per-thread caches, in-memory only. A missing key means "nothing cached
   * for this thread yet"; the user-visible chat panel reads
   * `threadsById[threadId]` through the thread-scoped selectors below.
   *
   * Modelled per thread (instead of a single `messages` array plus a stash
   * pattern) so concurrent agent runs across multiple threads — canvas chat
   * plus one or more question-node threads — each write to their own entry
   * without colliding when the user navigates away mid-stream.
   */
  threadsById: Record<string, ChatThreadState>;
  /** Persisted compose mode for every independent thread. */
  lastActionByThread: Record<string, AgentMode>;
  /** Persisted binding identity for independent Preview Workspace threads. */
  bindingByThread: Record<string, AgentBinding>;
  /** Persisted built-in model settings for independent threads. */
  settingsByThread: Record<
    string,
    { modelId: string | null; reasoningEffort: string | null }
  >;
  /** Question-owned threads whose binding and mode are durable on the node. */
  ephemeralMetadataThreads: Record<string, true>;
  /** Threads whose built-in settings are durable on the server. */
  ephemeralSettingsThreads: Record<string, true>;
  /** Map of canvasId → threadId, persisted so each canvas keeps its own thread. */
  threadMap: Record<string, string>;

  /**
   * Map of canvasId → AgentBinding, persisted so each canvas keeps its
   * own binding across reloads. Seeds the binding of a canvas's chat
   * thread; the server is stateless about thread bindings and reads the
   * binding from each request body.
   */
  bindingMap: Record<string, AgentBinding>;

  /**
   * The one text-selection excerpt, shared by every visible Chat. This is
   * presentation context, not thread state: there is a single browser
   * selection, so several Chats may offer the same hint. Whichever one sends
   * spends it, and the hint retires everywhere.
   */
  selectionAttachment: ChatAttachment | null;

  // Actions
  /**
   * Append a message to a specific thread's list. All writers take a
   * threadId explicitly: SSE callbacks pass the owner-thread captured
   * at send time, UI handlers pass their own session's thread.
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
  setThreadLastAction: (threadId: string, action: AgentMode) => void;
  /**
   * Create an empty loaded thread without changing the active-canvas pointer.
   * Preview Workspace uses this before opening the thread in a new Chat tab.
   */
  createThread: (options?: {
    binding?: AgentBinding;
    lastAction?: AgentMode;
  }) => string;
  /** Return the Canvas's canonical chat thread, creating its mapping once. */
  ensureCanvasThread: (canvasId: string) => string;
  /**
   * Change a thread's agent binding. Pass `canvasId` to also persist the
   * choice to `bindingMap` so it seeds the next thread on this canvas. UI
   * guards against calling this once a thread has messages (1 thread = 1
   * binding).
   */
  setAgentBinding: (
    threadId: string,
    binding: AgentBinding,
    canvasId?: string,
  ) => void;

  /** Replace a thread's built-in capability selection. */
  setThreadSettings: (
    threadId: string,
    settings: { modelId: string | null; reasoningEffort: string | null },
  ) => void;

  /** Stop persisting metadata after its authoritative owner is durable. */
  makeThreadMetadataEphemeral: (
    threadId: string,
    options?: { preserveSettings?: boolean },
  ) => void;

  /** Stage an attachment (e.g. from PDF capture) on a thread's next message. */
  addPendingAttachment: (threadId: string, attachment: ChatAttachment) => void;
  /** Remove one of a thread's staged attachments by index. */
  removePendingAttachment: (threadId: string, index: number) => void;
  /** Clear a thread's staged attachments (called after its message is sent). */
  clearPendingAttachments: (threadId: string) => void;

  /**
   * Set (or clear) the current thread's composer draft. Sending a message
   * clears the draft through this same path.
   */
  setDraft: (threadId: string, text: string) => void;

  /** Set/replace the text-selection-based attachment (auto-managed by ExpandedNodePanel). */
  setSelectionAttachment: (attachment: ChatAttachment | null) => void;

  /** Mark / unmark a thread as having an active streaming run. */
  setThreadLoading: (threadId: string, loading: boolean) => void;

  /**
   * Drop cached state for threads that aren't currently pinned.
   * A thread is "pinned" if it is:
   *   - streaming, or
   *   - mapped to a Canvas.
   *
   * Triggered when a thread is cleared. Writes stay hot; evicted threads are
   * refetched by `useChatHistory` the next time a tab renders them.
   */
  evictInactiveThreads: (maxKeep?: number) => void;
}

/**
 * Soft upper bound on cached threads. Picked to comfortably cover the
 * realistic working set (1 canvas chat + a handful of recently opened
 * question threads) without holding on to dead history forever. Crossing the
 * threshold drops *all* non-pinned entries at once — simple and predictable;
 * refetch on re-visit is cheap.
 */
const MAX_CACHED_THREADS = 10;

/** Stable empty array so selectors that miss the cache don't trigger renders. */
const EMPTY_MESSAGES: ChatMessage[] = [];

/** Stable default returned for a thread with nothing cached yet. */
const EMPTY_THREAD: ChatThreadState = {
  messages: EMPTY_MESSAGES,
  draft: '',
  historyLoaded: false,
  isStreaming: false,
  lastAction: DEFAULT_ACTION,
  binding: DEFAULT_BINDING,
  settings: { modelId: null, reasoningEffort: null },
  pendingAttachments: [],
};

function threadOf(state: ChatState, threadId: string): ChatThreadState {
  const binding = state.bindingByThread[threadId] ?? DEFAULT_BINDING;
  return (
    state.threadsById[threadId] ?? {
      ...EMPTY_THREAD,
      lastAction:
        state.lastActionByThread[threadId] ?? defaultActionForBinding(binding),
      binding,
      settings: state.settingsByThread[threadId] ?? EMPTY_THREAD.settings,
    }
  );
}

function rememberLastAction(
  state: ChatState,
  threadId: string,
  action: AgentMode,
): Record<string, AgentMode> {
  const entries = { ...state.lastActionByThread };
  entries[threadId] = action;
  return entries;
}

function rememberThreadValue<T>(
  entries: Record<string, T>,
  threadId: string,
  value: T,
): Record<string, T> {
  return { ...entries, [threadId]: value };
}

function normalizeThreadSettings(value: unknown): ChatThreadState['settings'] {
  if (!value || typeof value !== 'object') return EMPTY_THREAD.settings;
  const candidate = value as Record<string, unknown>;
  return {
    modelId:
      typeof candidate.modelId === 'string' || candidate.modelId === null
        ? candidate.modelId
        : null,
    reasoningEffort:
      typeof candidate.reasoningEffort === 'string' ||
      candidate.reasoningEffort === null
        ? candidate.reasoningEffort
        : null,
  };
}

/** Immutably patches one thread entry, creating it when absent. */
function patchThread(
  state: ChatState,
  threadId: string,
  patch: Partial<ChatThreadState>,
): Pick<ChatState, 'threadsById'> {
  return {
    threadsById: {
      ...state.threadsById,
      [threadId]: { ...threadOf(state, threadId), ...patch },
    },
  };
}

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      messagesByThread: {},
      draftsByThread: {},
      threadsById: {},
      lastActionByThread: {},
      bindingByThread: {},
      settingsByThread: {},
      ephemeralMetadataThreads: {},
      ephemeralSettingsThreads: {},
      threadMap: {},
      bindingMap: {},
      selectionAttachment: null,

      addMessage: (threadId, message) =>
        set((state) =>
          patchThread(state, threadId, {
            messages: [...threadOf(state, threadId).messages, message],
          }),
        ),

      updateMessage: (threadId, id, updater) =>
        set((state) => {
          const entry = state.threadsById[threadId];
          if (!entry) return {};
          return patchThread(state, threadId, {
            messages: entry.messages.map((m) => (m.id === id ? updater(m) : m)),
          });
        }),

      upsertAssistantToolPart: (threadId, messageId, toolCallId, factory) =>
        set((state) => {
          const entry = state.threadsById[threadId];
          if (!entry) return {};
          return patchThread(state, threadId, {
            messages: entry.messages.map((m) => {
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
          });
        }),

      setMessages: (threadId, messages) =>
        set((state) => patchThread(state, threadId, { messages })),

      setHistoryLoaded: (threadId, loaded) =>
        set((state) => {
          if (threadOf(state, threadId).historyLoaded === loaded) return {};
          return patchThread(state, threadId, { historyLoaded: loaded });
        }),

      setThreadLastAction: (threadId, action) =>
        set((state) => ({
          ...patchThread(state, threadId, { lastAction: action }),
          lastActionByThread: state.ephemeralMetadataThreads[threadId]
            ? state.lastActionByThread
            : rememberLastAction(state, threadId, action),
        })),

      createThread: (options) => {
        const threadId = createId('thread');
        const binding = options?.binding ?? DEFAULT_BINDING;
        const lastAction =
          options?.lastAction ?? defaultActionForBinding(binding);
        set((state) => ({
          ...patchThread(state, threadId, {
            messages: [],
            historyLoaded: true,
            binding,
            lastAction,
          }),
          lastActionByThread: rememberLastAction(state, threadId, lastAction),
          bindingByThread: rememberThreadValue(
            state.bindingByThread,
            threadId,
            binding,
          ),
        }));
        return threadId;
      },

      ensureCanvasThread: (canvasId) => {
        const state = get();
        const existing = state.threadMap[canvasId];
        if (existing) return existing;

        const threadId = createId('thread');
        const binding = state.bindingMap[canvasId] ?? DEFAULT_BINDING;
        set({
          ...patchThread(state, threadId, {
            binding,
            lastAction: defaultActionForBinding(binding),
          }),
          threadMap: { ...state.threadMap, [canvasId]: threadId },
          bindingMap: { ...state.bindingMap, [canvasId]: binding },
          bindingByThread: rememberThreadValue(
            state.bindingByThread,
            threadId,
            binding,
          ),
        });
        return threadId;
      },

      setAgentBinding: (threadId, binding, canvasId) => {
        const state = get();
        set({
          ...patchThread(state, threadId, { binding }),
          bindingByThread: state.ephemeralMetadataThreads[threadId]
            ? state.bindingByThread
            : rememberThreadValue(state.bindingByThread, threadId, binding),
          bindingMap: canvasId
            ? { ...state.bindingMap, [canvasId]: binding }
            : state.bindingMap,
        });
      },

      setThreadSettings: (threadId, settings) =>
        set((state) => {
          const current = threadOf(state, threadId).settings;
          if (
            current.modelId === settings.modelId &&
            current.reasoningEffort === settings.reasoningEffort
          ) {
            return {};
          }
          return {
            ...patchThread(state, threadId, { settings }),
            settingsByThread: state.ephemeralSettingsThreads[threadId]
              ? state.settingsByThread
              : rememberThreadValue(state.settingsByThread, threadId, settings),
          };
        }),

      makeThreadMetadataEphemeral: (threadId, options) =>
        set((state) => {
          const lastActionByThread = { ...state.lastActionByThread };
          const bindingByThread = { ...state.bindingByThread };
          const settingsByThread = { ...state.settingsByThread };
          delete lastActionByThread[threadId];
          delete bindingByThread[threadId];
          if (!options?.preserveSettings) delete settingsByThread[threadId];
          return {
            lastActionByThread,
            bindingByThread,
            settingsByThread,
            ephemeralMetadataThreads: {
              ...state.ephemeralMetadataThreads,
              [threadId]: true,
            },
            ephemeralSettingsThreads: options?.preserveSettings
              ? state.ephemeralSettingsThreads
              : {
                  ...state.ephemeralSettingsThreads,
                  [threadId]: true,
                },
          };
        }),

      addPendingAttachment: (threadId, attachment) =>
        set((state) =>
          patchThread(state, threadId, {
            pendingAttachments: [
              ...threadOf(state, threadId).pendingAttachments,
              attachment,
            ],
          }),
        ),

      removePendingAttachment: (threadId, index) =>
        set((state) =>
          patchThread(state, threadId, {
            pendingAttachments: threadOf(
              state,
              threadId,
            ).pendingAttachments.filter((_, i) => i !== index),
          }),
        ),

      clearPendingAttachments: (threadId) =>
        set((state) =>
          patchThread(state, threadId, { pendingAttachments: [] }),
        ),

      setDraft: (threadId, text) =>
        set((state) => {
          if (threadOf(state, threadId).draft === text) return {};
          return patchThread(state, threadId, { draft: text });
        }),

      setSelectionAttachment: (attachment) =>
        set({ selectionAttachment: attachment }),

      setThreadLoading: (threadId, loading) =>
        set((state) => {
          if (threadOf(state, threadId).isStreaming === loading) return {};
          return patchThread(state, threadId, { isStreaming: loading });
        }),

      evictInactiveThreads: (maxKeep = MAX_CACHED_THREADS) =>
        set((state) => {
          const cached = Object.keys(state.threadsById);
          if (cached.length <= maxKeep) return {};

          const pinned = new Set<string>(Object.values(state.threadMap));
          for (const [tid, entry] of Object.entries(state.threadsById)) {
            if (entry.isStreaming) pinned.add(tid);
          }
          const evictable = cached.filter((tid) => !pinned.has(tid));
          if (evictable.length === 0) return {};

          const threadsById = { ...state.threadsById };
          for (const tid of evictable) delete threadsById[tid];
          return { threadsById };
        }),
    }),
    {
      name: 'huabu-chat',
      version: 5,
      migrate: (persisted) => {
        const state = persisted as Partial<ChatState> & {
          lastAction?: AgentMode;
          threadId?: string;
        };
        const legacyThreadId = state.threadId;
        const threadMap = state.threadMap ?? {};
        const bindingMap = state.bindingMap ?? {};
        const bindingByThread = { ...(state.bindingByThread ?? {}) };
        for (const [canvasId, threadId] of Object.entries(threadMap)) {
          const binding = bindingMap[canvasId];
          if (threadId && binding && !bindingByThread[threadId]) {
            bindingByThread[threadId] = binding;
          }
        }
        const settingsByThread = Object.fromEntries(
          Object.entries(state.settingsByThread ?? {}).map(
            ([threadId, settings]) => [
              threadId,
              normalizeThreadSettings(settings),
            ],
          ),
        );
        return {
          threadMap,
          lastActionByThread:
            state.lastActionByThread ??
            (state.lastAction && legacyThreadId
              ? { [legacyThreadId]: state.lastAction }
              : {}),
          bindingByThread,
          settingsByThread,
          bindingMap,
        };
      },
      partialize: (state) => ({
        threadMap: state.threadMap,
        lastActionByThread: state.lastActionByThread,
        bindingByThread: state.bindingByThread,
        settingsByThread: state.settingsByThread,
        bindingMap: state.bindingMap,
      }),
    },
  ),
);

// ─── Thread-scoped reads ──────────────────────────────────────────────────
//
// Every read of a thread's cached state goes through one of these. They are
// the seam the Preview Workspace migration needs: once two Chat renderers can
// be mounted at once there is no "current thread" to read from, and callers
// must name the thread they mean.

/**
 * A thread's message list. Returns a stable empty array reference when the
 * thread has not been hydrated yet.
 */
export const selectThreadMessages = (
  state: ChatState,
  threadId: string,
): ChatMessage[] => threadOf(state, threadId).messages;

/** A thread's composer draft ('' when none). */
export const selectThreadDraft = (state: ChatState, threadId: string): string =>
  threadOf(state, threadId).draft;

/** True if a thread has been hydrated from the server. */
export const selectThreadHistoryLoaded = (
  state: ChatState,
  threadId: string,
): boolean => threadOf(state, threadId).historyLoaded;

/** True if a thread has an active streaming run. */
export const selectThreadIsLoading = (
  state: ChatState,
  threadId: string,
): boolean => threadOf(state, threadId).isStreaming;

/** The agent a thread is bound to. */
export const selectThreadBinding = (
  state: ChatState,
  threadId: string,
): AgentBinding => threadOf(state, threadId).binding;

/** The compose mode last selected for a thread. */
export const selectThreadLastAction = (
  state: ChatState,
  threadId: string,
): AgentMode => threadOf(state, threadId).lastAction;

/** A thread's built-in model / reasoning-effort overrides. */
export const selectThreadSettings = (
  state: ChatState,
  threadId: string,
): ChatThreadState['settings'] => threadOf(state, threadId).settings;

/** Attachments staged for a thread's next message. */
export const selectThreadPendingAttachments = (
  state: ChatState,
  threadId: string,
): ChatAttachment[] => threadOf(state, threadId).pendingAttachments;
