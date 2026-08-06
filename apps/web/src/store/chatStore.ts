// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { createId } from '@huabu/shared';

import type { ChatMessage } from './chatTypes';
import type {
  AgentBinding,
  AgentConversationView,
  AgentMode,
  AssistantToolPart,
  ChatAttachment,
} from '@huabu/shared';

/**
 * Default binding for any newly opened canvas / cleared thread.
 * v1: built-in Huabu agent. External bindings only appear when the
 * user explicitly picks an agent in the NewChatMenu.
 */
const DEFAULT_BINDING: AgentBinding = { kind: 'internal' };

export type QuestionThreadOpenPosition = 'last-user' | 'bottom';

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
  /** Current thread identifier for the active canvas. */
  threadId: string;
  /** Last agent mode — persisted to determine which checkpoint to load on refresh */
  lastAction: AgentMode;
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
   * When set, the chat panel is viewing a question node's conversation thread
   * instead of the normal canvas chat.
   *
   * Whether this is the *initial* composition of a freshly-created node vs a
   * replay of an already-run one is NOT stored here — it is derived from the
   * node's own status (`idle` = composing). That keeps a single source of
   * truth (the node) and avoids the stored flag drifting out of sync.
   */
  viewingQuestionThread:
    | (AgentConversationView & {
        openPosition: QuestionThreadOpenPosition;
        openSequence: number;
      })
    | null;

  questionReplayByCanvas: Record<
    string,
    {
      view: AgentConversationView;
      binding: AgentBinding;
      savedCanvasThreadId: string;
      savedCanvasBinding: AgentBinding;
      savedCanvasLastAction: AgentMode;
    }
  >;

  /**
   * When set, the chat panel is inspecting a single sketch cluster
   * (showing its synthesized tool-call style trace). Mutually exclusive
   * with `viewingQuestionThread`.
   */
  viewingSketchCluster: { clusterId: string } | null;

  /**
   * @internal Saved canvas thread ID so `closeQuestionThread` knows
   * which thread to restore. Messages are *not* stashed — they live in
   * `threadsById` keyed by their own threadId and survive the
   * round-trip naturally.
   */
  _savedCanvasThreadId?: string;
  /** @internal Saved canvas agent binding while viewing a question thread. */
  _savedCanvasBinding?: AgentBinding;
  /** @internal Saved canvas agent mode while viewing a question thread. */
  _savedCanvasLastAction?: AgentMode;

  /**
   * A text-selection excerpt shared by every visible Chat. This is
   * presentation context, not thread state: several Chats may show the same
   * hint, and only the one that sends snapshots it into its request.
   */
  selectionAttachment: ChatAttachment | null;

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
    options?: { binding?: AgentBinding; lastAction?: AgentMode },
  ) => void;

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

  /** Switch to a canvas — loads or creates its threadId, resets in-memory messages. */
  switchToCanvas: (canvasId: string) => void;

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

  /**
   * Open a question node's thread in the chat panel (replay mode).
   * Pass the question's `binding` so the panel title + ACP selectors
   * reflect the agent that answered. The replay mode (ask/operate) is
   * NOT passed here — ChatPanel derives it directly from the question
   * node's `agentMode`, making the node the single source of truth.
   * The canvas thread + binding + lastAction are stashed and restored
   * on close.
   *
   * Pass `canvasId` to also persist the replay pointer to
   * `questionReplayByCanvas` so a refresh / canvas re-entry restores
   * this view automatically.
   */
  openQuestionThread: (
    view: AgentConversationView,
    binding?: AgentBinding,
    canvasId?: string,
    openPosition?: QuestionThreadOpenPosition,
  ) => void;
  /**
   * Re-anchor an already-open headless conversation in its owner Canvas while
   * preserving that Canvas's own plain-chat state for replay close.
   */
  openQuestionThreadInOwnerCanvas: (
    view: AgentConversationView,
    binding?: AgentBinding,
  ) => void;
  /**
   * Open a freshly-created question node for *composition*: switch the
   * panel to the node's (empty) thread, focus the input, and leave the
   * agent binding mutable so the inline selector can change it before the
   * first message is sent. Unlike `openQuestionThread` this does not enter
   * read-only replay — the user types the question directly in the chat
   * input. The first send (handled in `useAgentStream.startStream`) authors
   * the node's `content` and locks its binding.
   *
   * Inherits the canvas's last-used binding as the default so the common
   * case needs no agent pick. Stashes the canvas thread / binding /
   * lastAction so leaving compose restores the plain canvas chat.
   */
  openQuestionCompose: (
    view: AgentConversationView,
    options?: { canvasId?: string; binding?: AgentBinding },
  ) => void;
  /**
   * Close question thread replay and return to normal canvas chat.
   * Pass `canvasId` to also drop the persisted replay pointer so the
   * next visit to this canvas opens the plain chat thread.
   */
  closeQuestionThread: (canvasId?: string) => void;

  /**
   * Open the inspector view for a single sketch cluster. Pass
   * `canvasId` to clear any persisted question-replay pointer for that
   * canvas — the two views are mutually exclusive, so an active sketch
   * inspection supersedes the prior replay on restore.
   */
  openSketchCluster: (clusterId: string, canvasId?: string) => void;
  /** Close the sketch cluster inspector view. */
  closeSketchCluster: () => void;

  /**
   * Drop the persisted `questionReplayByCanvas[canvasId]` entry when
   * its `nodeId` is no longer present in the supplied set. Called by
   * `canvasStore.loadCanvas` once nodes settle, so a question that was
   * deleted while the user was elsewhere doesn't strand the chat panel
   * on a foreign thread.
   */
  validateQuestionReplay: (
    canvasId: string,
    nodeIds: ReadonlySet<string>,
  ) => void;

  /**
   * React to question nodes deleted in the current canvas. When the
   * chat panel is actively showing one of the deleted nodes' threads
   * (replay OR compose), roll back to the plain canvas chat so the user
   * isn't stranded on an orphaned conversation whose anchor node is
   * gone. Also drops a persisted replay pointer for a deleted node even
   * when it isn't the one on screen. Called from the delete post-effect
   * so the cleanup happens immediately, not only on the next
   * `loadCanvas`.
   */
  handleQuestionNodesDeleted: (
    canvasId: string,
    deletedNodeIds: readonly string[],
  ) => void;

  /** Mark / unmark a thread as having an active streaming run. */
  setThreadLoading: (threadId: string, loading: boolean) => void;

  /**
   * Drop cached state for threads that aren't currently pinned.
   * A thread is "pinned" if it is:
   *   - the currently-visible `threadId`,
   *   - streaming,
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
  binding: DEFAULT_BINDING,
  settings: { modelId: null, reasoningEffort: null },
  pendingAttachments: [],
};

function threadOf(state: ChatState, threadId: string): ChatThreadState {
  return state.threadsById[threadId] ?? EMPTY_THREAD;
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

/**
 * Leaves a question view and returns to the stashed canvas chat.
 *
 * The stashed binding is replayed into the restored thread's entry because
 * after a refresh that entry does not exist yet: `threadsById` is in-memory
 * while the replay pointer is persisted.
 */
function leaveQuestionView(
  state: ChatState,
  canvasId?: string,
): Partial<ChatState> {
  const restoredThreadId = state._savedCanvasThreadId ?? state.threadId;
  const nextReplayMap =
    canvasId && canvasId in state.questionReplayByCanvas
      ? (() => {
          const next = { ...state.questionReplayByCanvas };
          delete next[canvasId];
          return next;
        })()
      : state.questionReplayByCanvas;

  return {
    ...(state._savedCanvasBinding
      ? patchThread(state, restoredThreadId, {
          binding: state._savedCanvasBinding,
        })
      : {}),
    viewingQuestionThread: null,
    threadId: restoredThreadId,
    lastAction: state._savedCanvasLastAction ?? state.lastAction,
    _savedCanvasThreadId: undefined,
    _savedCanvasBinding: undefined,
    _savedCanvasLastAction: undefined,
    questionReplayByCanvas: nextReplayMap,
  };
}

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      messagesByThread: {},
      draftsByThread: {},
      threadsById: {},
      threadId: createId('thread'),
      lastAction: 'ask',
      threadMap: {},
      bindingMap: {},
      selectionAttachment: null,
      viewingQuestionThread: null,
      questionReplayByCanvas: {},
      viewingSketchCluster: null,

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

      setLastAction: (action) => set({ lastAction: action }),

      clearMessages: (canvasId, options) => {
        const state = get();
        const { threadMap, bindingMap } = state;
        const newThreadId = createId('thread');
        const initialBinding = options?.binding ?? DEFAULT_BINDING;
        // Seed the new thread with the caller-chosen mode so the
        // persisted `lastAction` (which drives the ChatPanel mode
        // toggle across refreshes) reflects the user's explicit
        // pick from NewChatMenu rather than always snapping to 'ask'.
        const initialLastAction: AgentMode = options?.lastAction ?? 'ask';
        const updatedThreads = canvasId
          ? { ...threadMap, [canvasId]: newThreadId }
          : { ...threadMap };
        // New thread → caller-specified binding (defaults to built-in).
        // Persist the choice for this canvas so reloads agree with the
        // in-memory state.
        const updatedBindings = canvasId
          ? { ...bindingMap, [canvasId]: initialBinding }
          : { ...bindingMap };
        // Seed the new thread as empty and already history-loaded so the
        // history hook doesn't round-trip for a thread that cannot have any.
        set({
          ...patchThread(state, newThreadId, {
            messages: [],
            historyLoaded: true,
            binding: initialBinding,
          }),
          threadId: newThreadId,
          lastAction: initialLastAction,
          selectionAttachment: null,
          threadMap: updatedThreads,
          bindingMap: updatedBindings,
        });
        get().evictInactiveThreads();
      },

      setAgentBinding: (threadId, binding, canvasId) => {
        const state = get();
        set({
          ...patchThread(state, threadId, { binding }),
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
          return patchThread(state, threadId, { settings });
        }),

      switchToCanvas: (canvasId: string) => {
        const state = get();
        const { threadMap, bindingMap, questionReplayByCanvas } = state;
        const replay = questionReplayByCanvas[canvasId];

        if (replay) {
          // Restore the question-replay view for this canvas. The
          // saved canvas thread / binding / lastAction travel with the
          // entry so `closeQuestionThread` can roll back without
          // consulting the canvas, even after a full page refresh.
          const replayThreadId = replay.view.conversationOwner.threadId;
          set({
            ...patchThread(state, replayThreadId, { binding: replay.binding }),
            viewingQuestionThread: {
              ...replay.view,
              openPosition: 'bottom',
              openSequence: 0,
            },
            threadId: replayThreadId,
            _savedCanvasThreadId: replay.savedCanvasThreadId,
            _savedCanvasBinding: replay.savedCanvasBinding,
            _savedCanvasLastAction: replay.savedCanvasLastAction,
            // Keep `threadMap` aligned with the saved canvas thread so
            // closing the replay later returns to a thread the user
            // would recognise as the canvas chat — even if some other
            // path advanced `threadMap[canvasId]` since the replay
            // opened.
            threadMap: {
              ...threadMap,
              [canvasId]: replay.savedCanvasThreadId,
            },
            bindingMap: bindingMap[canvasId]
              ? bindingMap
              : { ...bindingMap, [canvasId]: replay.savedCanvasBinding },
            selectionAttachment: null,
            // Sketch inspector is mutually exclusive with replay.
            viewingSketchCluster: null,
          });
          get().evictInactiveThreads();
          return;
        }

        // No replay for this canvas — switch to its plain chat thread.
        // Clear any dangling question/sketch view + stash from a
        // previous canvas so the panel isn't stuck on a foreign thread.
        let tid = threadMap[canvasId];
        if (!tid) {
          tid = createId('thread');
        }
        const binding = bindingMap[canvasId] ?? DEFAULT_BINDING;
        set({
          // Only the binding is seeded here — messages stay untouched so a
          // cached thread renders instantly, and the history hook populates
          // an uncached one from the server.
          ...patchThread(state, tid, { binding }),
          threadId: tid,
          selectionAttachment: null,
          threadMap: { ...threadMap, [canvasId]: tid },
          bindingMap: bindingMap[canvasId]
            ? bindingMap
            : { ...bindingMap, [canvasId]: binding },
          viewingQuestionThread: null,
          viewingSketchCluster: null,
          _savedCanvasThreadId: undefined,
          _savedCanvasBinding: undefined,
          _savedCanvasLastAction: undefined,
        });
        get().evictInactiveThreads();
      },

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

      openQuestionThread: (
        view,
        binding,
        canvasId,
        openPosition = 'bottom',
      ) => {
        const state = get();
        const {
          threadId: currentThreadId,
          lastAction: currentLastAction,
          viewingQuestionThread: currentViewing,
          _savedCanvasThreadId: savedThreadIdSlot,
          _savedCanvasBinding: savedBindingSlot,
          _savedCanvasLastAction: savedLastActionSlot,
          questionReplayByCanvas,
        } = state;
        const currentBinding = threadOf(state, currentThreadId).binding;
        const threadId = view.conversationOwner.threadId;

        const nextOpenSequence = (currentViewing?.openSequence ?? 0) + 1;

        // Re-opening the same thread still carries a fresh positioning intent.
        if (
          currentViewing?.conversationOwner.threadId === threadId &&
          currentViewing.conversationOwner.canvasId ===
            view.conversationOwner.canvasId
        ) {
          set({
            viewingQuestionThread: {
              ...view,
              openPosition,
              openSequence: nextOpenSequence,
            },
            ...(canvasId && {
              questionReplayByCanvas: {
                ...questionReplayByCanvas,
                [canvasId]: {
                  view,
                  binding: binding ?? currentBinding,
                  savedCanvasThreadId: savedThreadIdSlot ?? currentThreadId,
                  savedCanvasBinding: savedBindingSlot ?? currentBinding,
                  savedCanvasLastAction:
                    savedLastActionSlot ?? currentLastAction,
                },
              },
            }),
          });
          return;
        }

        // If we're already viewing a different question thread, don't
        // overwrite the saved canvas state — keep the original.
        const isAlreadyViewing = currentViewing !== null;

        // Question-thread binding: prefer the binding the question was
        // actually run with; fall back to the default internal agent
        // for legacy nodes that pre-date `data.agentBinding`.
        const nextBinding: AgentBinding = binding ?? DEFAULT_BINDING;

        // NOTE: we deliberately do NOT touch `lastAction` here. The
        // replay view's mode is derived directly from the question
        // node's `data.agentMode` (see ChatPanel), so the node — not
        // this global toggle — is the single source of truth for which
        // mode follow-up turns run in. We only STASH the canvas
        // `lastAction` so `closeQuestionThread` can undo any pollution a
        // follow-up send caused via `startStream`'s `setLastAction`.
        //
        // Messages aren't stashed — they live in `threadsById`
        // keyed by their own threadId and survive the navigation. The
        // history hook handles first-time hydration of the question
        // thread; subsequent visits hit the cache.
        //
        // When `canvasId` is supplied we also write the same triple
        // (saved canvas thread / binding / lastAction) into
        // `questionReplayByCanvas[canvasId]` so a refresh or canvas
        // re-entry restores this view via `switchToCanvas`. When
        // already viewing another replay, we reuse the previously
        // stashed slots so the canvas state we eventually roll back to
        // is the user's pre-replay state, not the previous replay.
        const persistedSavedThreadId = isAlreadyViewing
          ? (savedThreadIdSlot ?? currentThreadId)
          : currentThreadId;
        const persistedSavedBinding = isAlreadyViewing
          ? (savedBindingSlot ?? currentBinding)
          : currentBinding;
        const persistedSavedLastAction = isAlreadyViewing
          ? (savedLastActionSlot ?? currentLastAction)
          : currentLastAction;

        set({
          ...patchThread(state, threadId, { binding: nextBinding }),
          viewingQuestionThread: {
            ...view,
            openPosition,
            openSequence: nextOpenSequence,
          },
          threadId: threadId,
          ...(!isAlreadyViewing && {
            _savedCanvasThreadId: currentThreadId,
            _savedCanvasBinding: currentBinding,
            _savedCanvasLastAction: currentLastAction,
          }),
          ...(canvasId && {
            questionReplayByCanvas: {
              ...questionReplayByCanvas,
              [canvasId]: {
                view,
                binding: nextBinding,
                savedCanvasThreadId: persistedSavedThreadId,
                savedCanvasBinding: persistedSavedBinding,
                savedCanvasLastAction: persistedSavedLastAction,
              },
            },
          }),
        });
        get().evictInactiveThreads();
      },

      openQuestionThreadInOwnerCanvas: (view, binding) => {
        const state = get();
        const {
          threadMap,
          bindingMap,
          lastAction,
          questionReplayByCanvas,
          viewingQuestionThread,
        } = state;
        const canvasId = view.conversationOwner.canvasId;
        const savedCanvasThreadId = threadMap[canvasId] ?? createId('thread');
        const savedCanvasBinding = bindingMap[canvasId] ?? DEFAULT_BINDING;
        const nextBinding = binding ?? DEFAULT_BINDING;
        const ownerView: AgentConversationView = {
          presentationAnchor: {
            canvasId,
            nodeId: view.conversationOwner.nodeId,
          },
          conversationOwner: view.conversationOwner,
        };

        set({
          ...patchThread(state, view.conversationOwner.threadId, {
            binding: nextBinding,
          }),
          viewingQuestionThread: {
            ...ownerView,
            openPosition: 'bottom',
            openSequence: (viewingQuestionThread?.openSequence ?? 0) + 1,
          },
          threadId: view.conversationOwner.threadId,
          _savedCanvasThreadId: savedCanvasThreadId,
          _savedCanvasBinding: savedCanvasBinding,
          _savedCanvasLastAction: lastAction,
          threadMap: {
            ...threadMap,
            [canvasId]: savedCanvasThreadId,
          },
          bindingMap: {
            ...bindingMap,
            [canvasId]: savedCanvasBinding,
          },
          questionReplayByCanvas: {
            ...questionReplayByCanvas,
            [canvasId]: {
              view: ownerView,
              binding: nextBinding,
              savedCanvasThreadId,
              savedCanvasBinding,
              savedCanvasLastAction: lastAction,
            },
          },
          selectionAttachment: null,
          viewingSketchCluster: null,
        });
        get().evictInactiveThreads();
      },

      openQuestionCompose: (view, options) => {
        const state = get();
        const {
          threadId: currentThreadId,
          lastAction: currentLastAction,
          viewingQuestionThread: currentViewing,
          bindingMap,
        } = state;
        const currentBinding = threadOf(state, currentThreadId).binding;
        const threadId = view.conversationOwner.threadId;

        // Already composing/viewing this exact thread — nothing to do.
        if (
          currentViewing?.conversationOwner.threadId === threadId &&
          currentViewing.conversationOwner.canvasId ===
            view.conversationOwner.canvasId
        ) {
          return;
        }

        // Default the new node to the canvas's last-used agent so the
        // common case (one agent per canvas) needs no explicit pick.
        const initialBinding: AgentBinding = options?.binding
          ? options.binding
          : options?.canvasId
            ? (bindingMap[options.canvasId] ?? DEFAULT_BINDING)
            : DEFAULT_BINDING;

        // Seed an empty message list for the node's thread and mark it
        // history-loaded so `useChatHistory` doesn't round-trip for a
        // thread that has never been sent.
        const seeded = patchThread(state, threadId, {
          messages: threadOf(state, threadId).messages,
          historyLoaded: true,
          binding: initialBinding,
        });

        // Stash the canvas chat state so leaving compose restores it —
        // but only when not already inside a question view, so the saved
        // slots always point at the user's real canvas chat.
        const isAlreadyViewing = currentViewing !== null;

        set({
          ...seeded,
          viewingQuestionThread: {
            ...view,
            openPosition: 'bottom',
            openSequence: (currentViewing?.openSequence ?? 0) + 1,
          },
          threadId,
          selectionAttachment: null,
          viewingSketchCluster: null,
          ...(!isAlreadyViewing && {
            _savedCanvasThreadId: currentThreadId,
            _savedCanvasBinding: currentBinding,
            _savedCanvasLastAction: currentLastAction,
          }),
        });
        get().evictInactiveThreads();
      },

      closeQuestionThread: (canvasId) => {
        set(leaveQuestionView(get(), canvasId));
        get().evictInactiveThreads();
      },

      openSketchCluster: (clusterId, canvasId) => {
        // Sketch inspector is a pure overlay over the existing chat
        // state — no thread switch needed. We just flip a flag and the
        // ChatPanel renders synthesized messages from the intent
        // store. Closing any active question thread first keeps the
        // two modes mutually exclusive — including its persisted
        // replay pointer for this canvas, so a refresh doesn't
        // re-resurrect the replay underneath the sketch view.
        const state = get();
        if (state.viewingQuestionThread) {
          set(leaveQuestionView(state, canvasId));
        }
        set({ viewingSketchCluster: { clusterId } });
      },

      closeSketchCluster: () => {
        set({ viewingSketchCluster: null });
      },

      validateQuestionReplay: (canvasId, nodeIds) => {
        const { questionReplayByCanvas, viewingQuestionThread } = get();
        const replay = questionReplayByCanvas[canvasId];
        if (!replay) return;
        if (
          replay.view.presentationAnchor.canvasId !== canvasId ||
          nodeIds.has(replay.view.presentationAnchor.nodeId)
        ) {
          return;
        }
        // The question node owning this replay was deleted while we
        // were elsewhere. If the panel is currently showing it, roll
        // back to the canvas chat — `closeQuestionThread` also wipes
        // the persisted pointer in the same set. Otherwise just drop
        // the dangling entry.
        if (
          viewingQuestionThread?.presentationAnchor.canvasId === canvasId &&
          viewingQuestionThread.presentationAnchor.nodeId ===
            replay.view.presentationAnchor.nodeId
        ) {
          get().closeQuestionThread(canvasId);
          return;
        }
        const next = { ...questionReplayByCanvas };
        delete next[canvasId];
        set({ questionReplayByCanvas: next });
      },

      handleQuestionNodesDeleted: (canvasId, deletedNodeIds) => {
        if (deletedNodeIds.length === 0) return;
        const { viewingQuestionThread, questionReplayByCanvas } = get();
        const deleted = new Set(deletedNodeIds);

        // The node backing the on-screen question thread was deleted —
        // return to the canvas chat. `closeQuestionThread` also drops
        // the persisted replay pointer for this canvas, so we're done.
        if (
          viewingQuestionThread &&
          viewingQuestionThread.presentationAnchor.canvasId === canvasId &&
          deleted.has(viewingQuestionThread.presentationAnchor.nodeId)
        ) {
          get().closeQuestionThread(canvasId);
          return;
        }

        // Not on screen, but a persisted replay pointer for this canvas
        // may now dangle at a deleted node — drop it so a later revisit
        // doesn't restore a foreign thread.
        const replay = questionReplayByCanvas[canvasId];
        if (
          replay &&
          replay.view.presentationAnchor.canvasId === canvasId &&
          deleted.has(replay.view.presentationAnchor.nodeId)
        ) {
          const next = { ...questionReplayByCanvas };
          delete next[canvasId];
          set({ questionReplayByCanvas: next });
        }
      },

      setThreadLoading: (threadId, loading) =>
        set((state) => {
          if (threadOf(state, threadId).isStreaming === loading) return {};
          return patchThread(state, threadId, { isStreaming: loading });
        }),

      evictInactiveThreads: (maxKeep = MAX_CACHED_THREADS) =>
        set((state) => {
          const cached = Object.keys(state.threadsById);
          if (cached.length <= maxKeep) return {};

          const pinned = new Set<string>([state.threadId]);
          for (const [tid, entry] of Object.entries(state.threadsById)) {
            if (entry.isStreaming) pinned.add(tid);
          }
          if (state._savedCanvasThreadId) {
            pinned.add(state._savedCanvasThreadId);
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
      version: 2,
      migrate: (persisted) => {
        const state = persisted as Partial<ChatState> & {
          questionReplayByCanvas?: Record<
            string,
            {
              nodeId?: string;
              threadId?: string;
              binding: AgentBinding;
              savedCanvasThreadId: string;
              savedCanvasBinding: AgentBinding;
              savedCanvasLastAction: AgentMode;
              view?: AgentConversationView;
            }
          >;
        };
        const migrated: ChatState['questionReplayByCanvas'] = {};
        for (const [canvasId, replay] of Object.entries(
          state.questionReplayByCanvas ?? {},
        )) {
          const view =
            replay.view ??
            (replay.nodeId && replay.threadId
              ? {
                  presentationAnchor: {
                    canvasId,
                    nodeId: replay.nodeId,
                  },
                  conversationOwner: {
                    canvasId,
                    nodeId: replay.nodeId,
                    threadId: replay.threadId,
                  },
                }
              : null);
          if (!view) continue;
          migrated[canvasId] = {
            view,
            binding: replay.binding,
            savedCanvasThreadId: replay.savedCanvasThreadId,
            savedCanvasBinding: replay.savedCanvasBinding,
            savedCanvasLastAction: replay.savedCanvasLastAction,
          };
        }
        return {
          threadMap: state.threadMap ?? {},
          threadId: state.threadId ?? createId('thread'),
          lastAction: state.lastAction ?? 'ask',
          bindingMap: state.bindingMap ?? {},
          questionReplayByCanvas: migrated,
        };
      },
      partialize: (state) => ({
        threadMap: state.threadMap,
        threadId: state.threadId,
        lastAction: state.lastAction,
        bindingMap: state.bindingMap,
        // Per-canvas replay pointers survive refresh so re-entering a
        // canvas while a question replay was open restores that view
        // instead of silently falling back to canvas chat. The
        // `_saved*` slots travel inside each entry, so they don't need
        // to be persisted as top-level fields.
        questionReplayByCanvas: state.questionReplayByCanvas,
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

/** The currently-visible thread's agent binding. */
export const selectCurrentBinding = (state: ChatState): AgentBinding =>
  selectThreadBinding(state, state.threadId);

/**
 * Read the currently-visible thread's message list. Returns a stable
 * empty array reference when the thread hasn't been hydrated yet.
 */
export const selectCurrentMessages = (state: ChatState): ChatMessage[] =>
  selectThreadMessages(state, state.threadId);

/** Read the currently-visible thread's composer draft ('' when none). */
export const selectCurrentDraft = (state: ChatState): string =>
  selectThreadDraft(state, state.threadId);

/** True if the currently-visible thread has been hydrated from the server. */
export const selectCurrentHistoryLoaded = (state: ChatState): boolean =>
  selectThreadHistoryLoaded(state, state.threadId);

/** True if the currently-visible thread has an active streaming run. */
export const selectCurrentIsLoading = (state: ChatState): boolean =>
  selectThreadIsLoading(state, state.threadId);
