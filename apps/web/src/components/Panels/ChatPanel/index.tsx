// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import clsx from 'clsx';
import { Bookmark, ListIndentIncrease, PanelRightOpen } from 'lucide-react';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import {
  createId,
  getQuestionNodeStatus,
  MODE_SELECTION_ID,
  MODEL_SELECTION_ID,
} from '@huabu/shared';

import {
  setAcpSessionConfigOption,
  setAcpSessionMode,
  setAcpSessionModel,
} from '@/api/acp';
import { Button } from '@/components/Common/Button';
import { Input } from '@/components/Common/Input';
import { toast } from '@/components/Common/Toast';
import { PermissionTray } from '@/components/Messages/AIMessage/PermissionCard';
import { useAcpProfiles } from '@/hooks/useAcpProfiles';
import { useAcpSessionMeta } from '@/hooks/useAcpSessionMeta';
import { useAcpSlashCommands } from '@/hooks/useAcpSlashCommands';
import { useBuiltinThreadSettings } from '@/hooks/useBuiltinThreadSettings';
import { ChatSessionProvider, type ChatSession } from '@/hooks/useChatSession';
import { useInternalSlashCommands } from '@/hooks/useInternalSlashCommands';
import { useAcpProfilesStore } from '@/store/acpProfilesStore';
import { useAcpThreadChangesStore } from '@/store/acpThreadChangesStore';
import useCanvasStore from '@/store/canvasStore';
import {
  selectThreadBinding,
  selectThreadDraft,
  selectThreadHistoryLoaded,
  selectThreadLastAction,
  selectThreadMessages,
  useChatStore,
} from '@/store/chatStore';
import { findPendingPermissionRequest } from '@/store/chatTypes';
import {
  isHeadlessConversation,
  resolveConversationOwnerSource,
} from '@/store/conversationOwner';
import { useLLMStore } from '@/store/llmStore';
import { messageListViewKey } from '@/store/previewWorkspace/scrollMemory';
import { usePreviewWorkspaceStore } from '@/store/previewWorkspace/store';
import { snapshotAgentIcon } from '@/utils/agentIcon';

import {
  AcpConnectionBadge,
  type AcpConnectionStatus,
} from './AcpConnectionBadge';
import { AcpSessionSelectors } from './AcpSessionSelectors';
import { bindingsEqual } from './agentMenu';
import { AgentSelector, type AgentChoice } from './AgentSelector';
import { BuiltinSessionSelectors } from './BuiltinSessionSelectors';
import { ChangeReviewCard } from './ChangeReviewCard';
import { ChatInput } from './ChatInput';
import { parseSlashInvocations } from './parseSlashInvocations';
import { saveChatAsQuestion } from './saveChatAsQuestion';
import { useAgentStream } from '../../../hooks/useAgentStream';
import { useChatHistory } from '../../../hooks/useChatHistory';
import { MessageList } from '../../Messages/MessageList';
import { SidebarPanel } from '../SidebarPanel';

import type { AgentIcon, AgentMode, CanvasNodeId } from '@huabu/shared';

interface ChatPanelProps {
  isCollapsed?: boolean;
  onToggle?: () => void;
  /** The conversation rendered by this Preview Workspace tab. */
  session: ChatSession;
  /** Workspace tab to convert in place when an unbound Chat is saved. */
  previewTabId: string;
  /** Active node in the other Preview split group, if one is visible. */
  adjacentNodeSourceId?: string;
  /** Reports a persistent thread mutation to the owning preview surface. */
  onCommit?: () => void;
  /** One-shot initial scroll request from Preview Workspace. */
  openPositionRequest?: {
    position: 'last-user' | 'bottom';
    nonce: number;
  };
  onOpenPositionHandled?: (nonce: number) => void;
}

export const ChatPanel = ({
  isCollapsed,
  onToggle,
  session,
  previewTabId,
  adjacentNodeSourceId,
  onCommit,
  openPositionRequest,
  onOpenPositionHandled,
}: ChatPanelProps) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const setDraft = useChatStore((state) => state.setDraft);
  const canvasId = useCanvasStore((state) => state.canvasId);

  // When the panel is replaying a question node's thread, the mode is a
  // property of that NODE (`data.agentMode`), not the thread's mutable
  // compose mode (the replay view hides the mode selector). We derive it
  // straight from the node, so the composer + every follow-up turn stay
  // structurally consistent with how the question itself runs: an
  // `@Agent` (operate) question keeps emitting operate turns, an `@Chat`
  // question stays in ask. External bindings have no ask/operate split
  // (their mode is ACP-managed), so they pin to ask. Falls back to ask
  // for legacy nodes that pre-date the `@` picker.
  const { threadId, ownerCanvasId } = session;
  const setThreadLastAction = useChatStore(
    (state) => state.setThreadLastAction,
  );
  const lastAction = useChatStore((state) =>
    selectThreadLastAction(state, threadId),
  );
  const activeConversationView = session.conversationView;

  // Composer draft lives in the store keyed by threadId (see chatStore
  // `ChatThreadState.draft`) so an unsent draft stays with its own session
  // instead of being wiped when the user switches canvas or opens a
  // question replay.
  const input = useChatStore((state) => selectThreadDraft(state, threadId));

  const viewingQuestionNodeId =
    activeConversationView?.conversationOwner.nodeId;
  const headlessConversation = isHeadlessConversation(activeConversationView);
  const conversationOwnerSource = useCanvasStore((state) =>
    resolveConversationOwnerSource(
      state.canvasId,
      state.nodes,
      state.worldReferences,
      activeConversationView,
    ),
  );
  const ownerScopeReady =
    !headlessConversation || conversationOwnerSource !== undefined;
  // "Composing" = the viewed question node has never been authored/run yet
  // (its status is still `idle`). Its binding remains mutable unless creation
  // explicitly fixed it; the mode follows this thread's inline pick rather
  // than the node's
  // not-yet-written `agentMode`. Derived from the node itself — the single
  // source of truth — rather than a stored `compose` flag. Replay (already-run
  // node) keeps deriving from the node.
  const isComposingQuestion =
    !headlessConversation &&
    !!viewingQuestionNodeId &&
    getQuestionNodeStatus(conversationOwnerSource) === 'idle';
  const questionReplayMode = (() => {
    if (!viewingQuestionNodeId || !conversationOwnerSource) return undefined;
    const d = conversationOwnerSource;
    return d.agentBinding?.kind === 'external' ? 'ask' : (d.agentMode ?? 'ask');
  })();
  const viewingQuestionBindingIsFixed =
    conversationOwnerSource?.agentBindingPolicy === 'fixed';
  // Bind-time avatar snapshot of the viewing question node, used as the
  // fallback icon in the agent chip when the bound external Profile no
  // longer exists — mirrors how the canvas node preserves its identity.
  const viewingQuestionAgentIcon = useCanvasStore((s) => {
    if (!viewingQuestionNodeId) return undefined;
    const node = s.nodes.find((n) => n.id === viewingQuestionNodeId);
    const d = node?.data as { agentIcon?: AgentIcon } | undefined;
    return d?.agentIcon;
  });

  // The viewing question node's authored label, used as the panel title
  // when replaying so the header reflects *which* question is open rather
  // than a generic "Question Replay". Empty while composing a brand-new
  // node (no content authored yet) — the title falls back accordingly.
  const viewingQuestionLabel =
    typeof conversationOwnerSource?.label === 'string'
      ? conversationOwnerSource.label.trim() || undefined
      : undefined;
  const isViewingUserNamedQuestion = headlessConversation
    ? !!viewingQuestionLabel
    : conversationOwnerSource?.labelSource === 'user';
  const tryRename = useCanvasStore((s) => s.tryRename);
  const canRenameQuestion = !!viewingQuestionNodeId && !headlessConversation;
  const [isEditingQuestionTitle, setIsEditingQuestionTitle] = useState(false);
  const [draftQuestionTitle, setDraftQuestionTitle] = useState(
    viewingQuestionLabel ?? '',
  );
  const questionTitleInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditingQuestionTitle) return;
    setDraftQuestionTitle(viewingQuestionLabel ?? '');
  }, [isEditingQuestionTitle, viewingQuestionLabel]);

  useEffect(() => {
    setIsEditingQuestionTitle(false);
  }, [viewingQuestionNodeId]);

  useEffect(() => {
    if (!isEditingQuestionTitle) return;
    questionTitleInputRef.current?.focus();
    questionTitleInputRef.current?.select();
  }, [isEditingQuestionTitle]);

  const mode: AgentMode =
    activeConversationView && !isComposingQuestion
      ? (questionReplayMode ?? 'ask')
      : lastAction;

  // Agent stream hook — manages streaming and loading state
  const { isLoading, setIsLoading, startStream, stopStream } = useAgentStream(
    session,
    previewTabId,
  );

  // Chat history hook — loads history and handles reconnection
  useChatHistory(session, setIsLoading, previewTabId);

  // Persistent chat state. Messages are per-thread (see chatStore.ts);
  // every read names this session's thread, so a stream running in another
  // thread (e.g. a question node) does not paint into this list.
  const messages = useChatStore((state) =>
    selectThreadMessages(state, threadId),
  );
  const pendingPermission = useMemo(
    () => findPendingPermissionRequest(messages),
    [messages],
  );
  const isHistoryLoaded = useChatStore((state) =>
    selectThreadHistoryLoaded(state, threadId),
  );
  // Wire the composer's onChange to the current thread's draft slot. An
  // empty string clears the draft (see `setDraft`), so the existing
  // `setInput('')` on send doubles as clear-on-send.
  const setInput = useCallback(
    (text: string) => setDraft(threadId, text),
    [setDraft, threadId],
  );
  const addNode = useCanvasStore((state) => state.addNode);
  const llmConfig = useLLMStore((state) => state.config);
  const llmLoading = useLLMStore((state) => state.loading);
  const llmInit = useLLMStore((state) => state.init);

  // Thread → agent binding. The binding is locked for the lifetime of
  // a thread; the only way to change it is to open a new workspace Chat.
  const agentBinding = useChatStore((state) =>
    selectThreadBinding(state, threadId),
  );
  const setAgentBinding = useChatStore((state) => state.setAgentBinding);
  const fixedAgentBinding = viewingQuestionBindingIsFixed
    ? conversationOwnerSource?.agentBinding
    : undefined;
  const {
    profiles: acpProfiles,
    refresh: refreshAcpProfiles,
    loaded: acpProfilesLoaded,
  } = useAcpProfiles();
  const activeExternalProfile =
    agentBinding.kind === 'external'
      ? acpProfiles.find((profile) => profile.id === agentBinding.profileId)
      : undefined;

  useEffect(() => {
    if (!fixedAgentBinding || bindingsEqual(agentBinding, fixedAgentBinding)) {
      return;
    }
    setAgentBinding(threadId, fixedAgentBinding);
  }, [agentBinding, fixedAgentBinding, setAgentBinding, threadId]);

  // Auto-reset a stale external binding on an *empty* thread: the
  // persisted binding refers to a profile that no longer exists
  // (user deleted it from Settings, or imported a workspace whose
  // profiles were never created locally). Threads with messages
  // keep the stale binding so the title still reads "Chat with
  // <alias>" — the user can recreate the profile in Settings to
  // bring the binding back to life.
  useEffect(() => {
    if (headlessConversation) return;
    if (viewingQuestionBindingIsFixed) return;
    if (!isHistoryLoaded) return;
    if (messages.length > 0) return;
    if (!acpProfilesLoaded) return;
    if (agentBinding.kind !== 'external') return;
    const profileExists = acpProfiles.some(
      (p) => p.id === agentBinding.profileId,
    );
    if (profileExists) return;
    setAgentBinding(threadId, { kind: 'internal' }, canvasId || undefined);
  }, [
    isHistoryLoaded,
    messages.length,
    acpProfilesLoaded,
    agentBinding,
    acpProfiles,
    canvasId,
    headlessConversation,
    viewingQuestionBindingIsFixed,
    setAgentBinding,
    threadId,
  ]);

  // Load the persisted change-review records when a thread opens so the
  // change card survives reload / a canvas that was previously closed.
  // Applies to both ACP threads and the built-in chat agent (C2), which
  // now also broadcasts its changes to the per-thread card.
  const loadThreadChanges = useAcpThreadChangesStore((s) => s.load);
  useEffect(() => {
    if (!ownerScopeReady || !ownerCanvasId || !threadId) return;
    void loadThreadChanges(ownerCanvasId, threadId);
  }, [ownerScopeReady, ownerCanvasId, threadId, loadThreadChanges]);

  // Whether the per-thread change card is currently showing, so the
  // chat input can merge with it into one connected box.
  const hasThreadChanges = useAcpThreadChangesStore((s) =>
    threadId ? (s.byThread[threadId]?.length ?? 0) > 0 : false,
  );

  // Gate the ACP per-thread hooks on the binding being external. We
  // intentionally do NOT also gate on the profile still existing in
  // the profile list: post-snapshot-refactor each thread carries its
  // own binding recipe (see server's session-store `bindingRecipe`),
  // so a deleted-profile thread still has a usable transport. If the
  // server can't resolve a recipe (orphan v2 record with no profile)
  // the ensure-session call surfaces a clear error and the badge flips
  // to `failed` — that's the right channel for it.
  const acpExternalReachable = agentBinding.kind === 'external';

  // Slash commands have two independent sources depending on the
  // thread binding:
  //
  //   • external → the bound ACP agent's `available_commands_update`
  //     push (via `useAcpSlashCommands`).
  //   • internal + operate mode → the workspace's user-authored skill
  //     catalogue (via `useInternalSlashCommands`), filtered to
  //     `user` / `merged` skills only. System skills stay in the
  //     agent's catalogue but are not user-invokable here — see
  //     `apps/server/src/modules/agent/skills.route.ts` for the
  //     server-side rationale.
  //
  // **Why operate-only for internal?** Ask mode is a Q&A surface
  // where skill invocation is semantically out of place — the user
  // is asking a question, not commissioning an action. Restricting
  // `/` to operate mode keeps the menu out of the ask experience
  // entirely (no popover, no parser pass on submit) so a leading
  // `/foo` in a question prompt is never silently reinterpreted.
  //
  // Each hook is also gated on its binding being active so we never
  // fire a doomed request (ACP unreachable, internal binding
  // switching to external mid-render, etc.). The selected
  // `{commands, refreshSlashCommands}` pair is the one ChatInput
  // consumes — the typeahead component itself is binding-agnostic.
  const acpSlash = useAcpSlashCommands({
    threadId,
    binding: agentBinding,
    canvasId: ownerCanvasId,
    enabled: ownerScopeReady && acpExternalReachable,
  });
  const internalSlash = useInternalSlashCommands({
    binding: agentBinding,
    scope: mode,
    enabled: agentBinding.kind === 'internal' && mode === 'operate',
  });
  const slashCommands = acpExternalReachable
    ? acpSlash.commands
    : internalSlash.commands;
  const slashLoading = acpExternalReachable
    ? acpSlash.loading
    : internalSlash.loading;
  const refreshSlashCommands = acpExternalReachable
    ? acpSlash.refreshIfStale
    : internalSlash.refreshIfStale;

  // Stable Set of currently-known slash ids — used by the submit
  // parser to decide which leading `/<id>` tokens count as skill
  // invocations vs. literal message text. Recomputed only when the
  // active source's commands list changes.
  const knownSlashIds = useMemo(
    () => new Set(slashCommands.map((c) => c.name)),
    [slashCommands],
  );

  // ACP session-meta (mode / model / config options / info / usage).
  // Drives the dropdown trio in ChatInput's toolbar. Empty when the
  // binding is internal — selectors then render nothing.
  // `loading` is plumbed into `AcpSessionSelectors` so the toolbar
  // can show a placeholder pill while the initial fetch is in-flight
  // instead of looking inert.
  const {
    meta: acpSessionMeta,
    loading: acpSessionMetaLoading,
    error: acpSessionMetaError,
    errorCode: acpSessionMetaErrorCode,
    applyOptimistic: applyAcpSessionMetaOptimistic,
  } = useAcpSessionMeta({
    threadId,
    binding: agentBinding,
    canvasId: ownerCanvasId,
    enabled: ownerScopeReady && acpExternalReachable,
    autoEnsureOnCacheMiss:
      activeExternalProfile?.launch.kind !== 'agent-team-manifest',
  });

  // Keep a ref to the latest snapshot so the optimistic handlers can
  // read prior values for revert without re-creating themselves (and
  // their downstream consumers) on every meta tick.
  const acpSessionMetaRef = useRef(acpSessionMeta);
  useEffect(() => {
    acpSessionMetaRef.current = acpSessionMeta;
  }, [acpSessionMeta]);

  // Built-in agent per-thread selectors (model + reasoning effort). Data
  // source is Huabu's own model capability, not an ACP agent's
  // configOptions; only active for internal bindings.
  const builtinThreadSettings = useBuiltinThreadSettings({
    threadId,
    canvasId: ownerCanvasId,
    provider: llmConfig?.provider,
    defaultModelId: llmConfig?.model,
    enabled: ownerScopeReady && agentBinding.kind !== 'external',
    threadHasMessages: messages.length > 0,
  });

  // Three-state connection summary for the header badge, derived from
  // `useAcpSessionMeta`. **Optimistic green by default** — opening a
  // thread is no longer a "connection in flight" event because we
  // hydrate selectors from the server's cached meta snapshot without
  // spawning the agentlet (see `useAcpSessionMeta`'s mount effect).
  // The badge only deviates from `connected` when there is positive
  // evidence of trouble:
  //
  //   connecting: a real `ensureAcpSession` (refresh / set-RPC) is
  //               currently in flight
  //   failed:     the last `ensureAcpSession` rejected AND we have
  //               no cached snapshot to fall back on (`updatedAt === 0`)
  //   connected:  everything else — cache hit, post-success steady
  //               state, or transient ensure failure that still leaves
  //               us with a valid (if possibly stale) snapshot. We
  //               degrade gracefully here: showing red just because a
  //               background refresh failed while the cached state is
  //               perfectly usable would be noise.
  //
  // Internal bindings get `null` — the parent only renders the badge
  // for `agentBinding.kind === 'external'`.
  //
  // Profile deletion is intentionally NOT an input here: after the
  // thread-binding-snapshot refactor each thread carries its own
  // recipe, so removing the profile in Settings has no effect on a
  // running thread's transport health. The only signal that matters
  // for "is this thread usable right now" is the live meta pipeline.
  const acpConnectionStatus: AcpConnectionStatus | null =
    agentBinding.kind !== 'external'
      ? null
      : acpSessionMetaLoading
        ? 'connecting'
        : acpSessionMetaError && acpSessionMeta.updatedAt === 0
          ? 'failed'
          : 'connected';

  // Optimistic onChange handlers for the ACP selectors: merge the
  // chosen value into the local snapshot immediately, then fire the
  // REST set-RPC. On failure, revert the snapshot and surface a toast
  // so the user knows the agent rejected the change.
  //
  // Spawn context threaded into every set-RPC: the selector dropdowns
  // are seeded from the no-spawn cached-meta snapshot, so the user can
  // switch a value before the session has ever been opened. Passing
  // `{ profileId, canvasId }` lets the server open the session
  // on-demand instead of rejecting the switch with `session_not_found`.
  const acpSetRpcSpawnCtx = useMemo(
    () => ({
      profileId:
        agentBinding.kind === 'external' ? agentBinding.profileId : undefined,
      canvasId: ownerCanvasId ?? undefined,
    }),
    [agentBinding, ownerCanvasId],
  );

  // Set-RPC handlers.
  //
  // Each one records the choice in the snapshot's `selections` map before
  // the round-trip so the pill updates immediately, and drops it again on
  // failure so the pill falls back to whatever the agent reports. That map
  // is also what the server persists as this thread's intent, so the
  // optimistic write mirrors the durable one instead of inventing a
  // second, UI-only notion of "current".
  const handleAcpSelectMode = useCallback(
    async (modeId: string) => {
      if (!threadId) return;
      const previous =
        acpSessionMetaRef.current.selections[MODE_SELECTION_ID] ?? null;
      applyAcpSessionMetaOptimistic({
        selection: { id: MODE_SELECTION_ID, value: modeId },
      });
      try {
        await setAcpSessionMode(threadId, { modeId, ...acpSetRpcSpawnCtx });
        onCommit?.();
      } catch (err) {
        applyAcpSessionMetaOptimistic({
          selection: { id: MODE_SELECTION_ID, value: previous },
        });
        toast(
          err instanceof Error
            ? t('chat.failedSwitchModeWithMessage', { message: err.message })
            : t('chat.failedSwitchMode'),
          { tone: 'danger' },
        );
      }
    },
    [threadId, applyAcpSessionMetaOptimistic, acpSetRpcSpawnCtx, onCommit, t],
  );

  const handleAcpSelectModel = useCallback(
    async (modelId: string) => {
      if (!threadId) return;
      const previous =
        acpSessionMetaRef.current.selections[MODEL_SELECTION_ID] ?? null;
      applyAcpSessionMetaOptimistic({
        selection: { id: MODEL_SELECTION_ID, value: modelId },
      });
      try {
        await setAcpSessionModel(threadId, { modelId, ...acpSetRpcSpawnCtx });
        onCommit?.();
      } catch (err) {
        applyAcpSessionMetaOptimistic({
          selection: { id: MODEL_SELECTION_ID, value: previous },
        });
        toast(
          err instanceof Error
            ? t('chat.failedSwitchModelWithMessage', { message: err.message })
            : t('chat.failedSwitchModel'),
          { tone: 'danger' },
        );
      }
    },
    [threadId, applyAcpSessionMetaOptimistic, acpSetRpcSpawnCtx, onCommit, t],
  );

  const handleAcpSelectConfigOption = useCallback(
    async (optionId: string, value: string | boolean) => {
      if (!threadId) return;
      const previous = acpSessionMetaRef.current.selections[optionId] ?? null;
      applyAcpSessionMetaOptimistic({
        selection: { id: optionId, value },
      });
      try {
        await setAcpSessionConfigOption(threadId, {
          configOptionId: optionId,
          value,
          ...acpSetRpcSpawnCtx,
        });
        onCommit?.();
      } catch (err) {
        applyAcpSessionMetaOptimistic({
          selection: { id: optionId, value: previous },
        });
        toast(
          err instanceof Error
            ? t('chat.failedUpdateOptionWithMessage', { message: err.message })
            : t('chat.failedUpdateOption'),
          { tone: 'danger' },
        );
      }
    },
    [threadId, applyAcpSessionMetaOptimistic, acpSetRpcSpawnCtx, onCommit, t],
  );

  // Question thread replay mode
  const openOwnerSpaceForReview = useCallback(() => {
    if (!activeConversationView || !headlessConversation) return;
    const owner = activeConversationView.conversationOwner;
    navigate(`/canvas/${owner.canvasId}`, {
      state: {
        previewNode: { canvasId: owner.canvasId, nodeId: owner.nodeId },
      },
    });
  }, [headlessConversation, navigate, activeConversationView]);

  useEffect(() => {
    if (!llmConfig && !llmLoading) {
      void llmInit();
    }
  }, [llmConfig, llmLoading, llmInit]);

  const panelTitle = useMemo(() => {
    if (activeConversationView) {
      // Composing a fresh node: it has no real label yet, so show a
      // neutral title instead of the auto-generated "Question N". A
      // manual sidebar rename is real authored identity and stays visible.
      if (isComposingQuestion && !isViewingUserNamedQuestion) {
        return t('chat.newQuestion');
      }
      return viewingQuestionLabel ?? t('chat.question');
    }
    // When the thread is delegated to an external ACP agent, the
    // built-in model name is irrelevant — surface the agent alias
    // instead so the header reflects who's actually answering.
    if (agentBinding.kind === 'external') {
      return t('chat.chatWith', { name: agentBinding.alias });
    }
    return t('chat.title');
  }, [
    agentBinding,
    t,
    activeConversationView,
    isComposingQuestion,
    isViewingUserNamedQuestion,
    viewingQuestionLabel,
  ]);

  const commitQuestionTitle = useCallback(() => {
    if (!viewingQuestionNodeId) {
      setIsEditingQuestionTitle(false);
      setDraftQuestionTitle(viewingQuestionLabel ?? '');
      return;
    }
    const next = draftQuestionTitle.trim();
    if (!next || next === (viewingQuestionLabel ?? '').trim()) {
      setIsEditingQuestionTitle(false);
      setDraftQuestionTitle(viewingQuestionLabel ?? '');
      return;
    }
    setIsEditingQuestionTitle(false);
    void tryRename('node', viewingQuestionNodeId, next).then((accepted) => {
      if (accepted) onCommit?.();
      else setDraftQuestionTitle(viewingQuestionLabel ?? '');
    });
  }, [
    draftQuestionTitle,
    onCommit,
    tryRename,
    viewingQuestionLabel,
    viewingQuestionNodeId,
  ]);

  const handleSubmit = async (e: React.FormEvent, agentMode: AgentMode) => {
    e.preventDefault();
    // Strip leading `/<id>` tokens that match a known slash command
    // and forward them as `invokedSkills`. Skill invocation is gated
    // to **internal + operate mode** only:
    //
    //  - External (ACP) bindings: skip parsing entirely. ACP agents
    //    handle their own slash dispatch inside the prompt body, so
    //    re-splitting here would double-strip the leading token.
    //  - Internal + ask mode: skip parsing too. Ask is a Q&A surface
    //    where a leading `/foo` is just literal text (e.g. a path or
    //    a typo); the menu is suppressed upstream and submit must
    //    mirror that or the two halves of the UX would disagree.
    //  - Internal + operate mode: parse, dedup, forward.
    //
    // Unknown `/foo` tokens in operate mode pass through as literal
    // message text — matches the typeahead UX (no menu hit → no
    // recognition).
    const raw = input;
    setInput('');
    const isSkillInvocationAllowed =
      agentBinding.kind === 'internal' && agentMode === 'operate';
    if (!isSkillInvocationAllowed) {
      const prompt = raw.trim();
      if (!prompt) return;
      onCommit?.();
      await startStream(prompt, agentMode);
      return;
    }
    const { invokedSkills, message } = parseSlashInvocations(
      raw,
      knownSlashIds,
    );
    const prompt = message.trim();
    if (!prompt) return;
    onCommit?.();
    await startStream(
      prompt,
      agentMode,
      invokedSkills.length > 0 ? invokedSkills : undefined,
    );
  };

  // Inline agent selector (left of the chat input toolbar). The binding
  // is mutable only while the thread has no user message yet — once a
  // turn is sent, 1-thread-1-binding locks it and the selector renders
  // read-only. Picking an agent rebinds the *current* (empty) thread in
  // place; it never mints a new thread.
  const threadHasUserMessage = messages.some((m) => m.role === 'user');
  const agentSelectorEditable =
    !headlessConversation &&
    !viewingQuestionBindingIsFixed &&
    !threadHasUserMessage &&
    !isLoading;
  const handleSelectAgent = useCallback(
    (choice: AgentChoice) => {
      // Agent binding is immutable once a turn starts (1 thread = 1 binding).
      // The selector is already read-only then; keep this guard as defense in
      // depth in case a stale menu event arrives during the transition.
      if (isLoading || viewingQuestionBindingIsFixed) return;
      setAgentBinding(threadId, choice.binding, canvasId || undefined);
      setThreadLastAction(threadId, choice.mode);
      onCommit?.();
    },
    [
      isLoading,
      onCommit,
      viewingQuestionBindingIsFixed,
      setAgentBinding,
      setThreadLastAction,
      canvasId,
      threadId,
    ],
  );

  const canSave =
    !activeConversationView &&
    !isLoading &&
    messages.some((m) => m.role === 'user' && m.content.trim().length > 0);
  const handleSaveChat = useCallback(() => {
    if (isLoading) return;
    const firstUser = messages.find(
      (m): m is Extract<typeof m, { role: 'user' }> => m.role === 'user',
    );
    if (!firstUser) return;
    const content = firstUser.content.trim();
    if (!content) return;

    const questionNodeId = createId('node') as CanvasNodeId;
    saveChatAsQuestion(
      {
        id: questionNodeId,
        nodeType: 'question',
        data: {
          type: 'question',
          content,
          status: 'done',
          viewed: true,
          threadId,
          agentBinding,
          agentIcon: snapshotAgentIcon(
            agentBinding,
            useAcpProfilesStore.getState().profiles,
          ),
          agentMode: mode,
        },
      },
      {
        canvasId,
        previewTabId,
        addNode,
        nodeExists: (nodeId) =>
          useCanvasStore.getState().nodes.some((node) => node.id === nodeId),
        replaceTabTarget: (tabId, target) =>
          usePreviewWorkspaceStore.getState().replaceTabTarget(tabId, target),
      },
    );
  }, [
    isLoading,
    messages,
    threadId,
    agentBinding,
    mode,
    canvasId,
    addNode,
    previewTabId,
  ]);

  return (
    <ChatSessionProvider value={session}>
      <SidebarPanel
        title={panelTitle}
        tabs={
          <span className="flex min-w-0 flex-1 items-center gap-1">
            {canRenameQuestion && isEditingQuestionTitle ? (
              <Input
                ref={questionTitleInputRef}
                value={draftQuestionTitle}
                aria-label={t('node.rename')}
                placeholder={t('node.untitled')}
                className="text-fg-default bg-bg-default border-edge-default w-64 max-w-full min-w-0 truncate rounded border px-1 py-0.5 text-sm font-semibold outline-none"
                onChange={(event) => setDraftQuestionTitle(event.target.value)}
                onBlur={commitQuestionTitle}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    commitQuestionTitle();
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    setDraftQuestionTitle(viewingQuestionLabel ?? '');
                    setIsEditingQuestionTitle(false);
                  }
                }}
              />
            ) : canRenameQuestion ? (
              <Button
                variant="ghost"
                size="sm"
                title={t('node.rename')}
                aria-label={t('node.rename')}
                tooltipPlacement="bottom"
                className={clsx(
                  'hover:text-fg-default min-w-0 cursor-text justify-start truncate rounded border border-transparent px-1 py-0.5 text-sm font-semibold',
                )}
                onClick={() => setIsEditingQuestionTitle(true)}
              >
                {panelTitle}
              </Button>
            ) : (
              <span className="min-w-0 truncate px-1 py-0.5">{panelTitle}</span>
            )}
            {acpConnectionStatus && agentBinding.kind === 'external' && (
              <AcpConnectionBadge
                status={acpConnectionStatus}
                alias={agentBinding.alias}
                errorMessage={acpSessionMetaError?.message ?? null}
                errorCode={acpSessionMetaErrorCode}
              />
            )}
          </span>
        }
        isCollapsed={isCollapsed}
        onToggle={onToggle}
        iconCollapsed={<PanelRightOpen size={16} />}
        iconExpanded={<ListIndentIncrease size={16} />}
        compactHeader
        hideTitle={!activeConversationView}
        tools={
          activeConversationView ? null : (
            <Button
              variant="ghost"
              tone="neutral"
              size="md"
              iconOnly
              onClick={handleSaveChat}
              disabled={!isHistoryLoaded || isLoading || !canSave}
              title={t('chat.saveAsQuestion')}
              tooltipPlacement="bottom"
            >
              <Bookmark />
            </Button>
          )
        }
      >
        <div className="flex h-full flex-col gap-2 overflow-visible pt-3">
          <MessageList
            messages={messages}
            isLoading={isLoading}
            isHistoryLoading={!isHistoryLoaded}
            viewKey={messageListViewKey(ownerCanvasId, threadId)}
            isActive={!isCollapsed}
            openPosition={
              pendingPermission
                ? 'bottom'
                : (openPositionRequest?.position ?? 'bottom')
            }
            openPositionRequestNonce={openPositionRequest?.nonce}
            onOpenPositionHandled={onOpenPositionHandled}
            onRetry={() => {
              // Find the last user message and re-send it
              const lastUserMsg = [...messages]
                .reverse()
                .find((m) => m.role === 'user');
              if (lastUserMsg && lastUserMsg.role === 'user') {
                void startStream(lastUserMsg.content, mode);
              }
            }}
          />

          <div className="px-3 pb-2">
            {pendingPermission ? (
              <div className="mb-2">
                <PermissionTray
                  threadId={threadId}
                  messageId={pendingPermission.messageId}
                  part={pendingPermission.part}
                />
              </div>
            ) : null}
            {ownerCanvasId && threadId && !headlessConversation ? (
              <ChangeReviewCard canvasId={ownerCanvasId} threadId={threadId} />
            ) : null}
            {headlessConversation && hasThreadChanges ? (
              <div className="border-edge-default bg-surface -mb-px flex items-center justify-between gap-3 rounded-t-2xl border border-b-0 px-3 py-2 text-xs">
                <span className="text-fg-muted">
                  {t('world.sourceChangesAvailable')}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={openOwnerSpaceForReview}
                >
                  {t('world.openSpaceForReview')}
                </Button>
              </div>
            ) : null}
            <ChatInput
              value={input}
              onChange={setInput}
              onSubmit={handleSubmit}
              onCommit={onCommit}
              onStop={stopStream}
              adjacentNodeSourceId={adjacentNodeSourceId}
              isStreaming={isLoading}
              mode={mode}
              connectedTop={hasThreadChanges}
              slashCommands={slashCommands}
              slashLoading={slashLoading}
              onSlashMenuIntent={refreshSlashCommands}
              agentSelectorSlot={
                <AgentSelector
                  currentBinding={agentBinding}
                  currentMode={mode}
                  profiles={acpProfiles}
                  editable={agentSelectorEditable}
                  onSelect={handleSelectAgent}
                  onRefreshProfiles={refreshAcpProfiles}
                  disabled={!isHistoryLoaded}
                  fallbackIcon={viewingQuestionAgentIcon}
                />
              }
              acpSelectorsSlot={
                agentBinding.kind === 'external' ? (
                  <AcpSessionSelectors
                    meta={acpSessionMeta}
                    loading={acpSessionMetaLoading}
                    onSelectMode={handleAcpSelectMode}
                    onSelectModel={handleAcpSelectModel}
                    onSelectConfigOption={handleAcpSelectConfigOption}
                  />
                ) : (
                  <BuiltinSessionSelectors
                    models={builtinThreadSettings.models}
                    currentModelId={builtinThreadSettings.effectiveModelId}
                    currentReasoningEffort={
                      builtinThreadSettings.settings.reasoningEffort
                    }
                    loading={builtinThreadSettings.loading}
                    onSelectModel={async (modelId) => {
                      await builtinThreadSettings.selectModel(modelId);
                      onCommit?.();
                    }}
                    onSelectReasoningEffort={async (effort) => {
                      await builtinThreadSettings.selectReasoningEffort(effort);
                      onCommit?.();
                    }}
                  />
                )
              }
              // For external (ACP) bindings, defer to the agent's own
              // `session_usage_update`; the internal context-token fetch
              // would return 0 and the hardcoded 128k window is wrong
              // for non-GPT-4o models. `undefined` keeps the legacy
              // built-in path; `null` hides the ring until the agent
              // pushes its first usage snapshot.
              contextUsageOverride={
                agentBinding.kind === 'external'
                  ? acpSessionMeta.usage
                  : undefined
              }
              // Profile deletion no longer blocks Send: the thread carries
              // its own binding recipe and continues running off the
              // snapshot. Transport-health gating is now expressed via the
              // connection badge above; we keep the input enabled so the
              // user can retry / trigger a re-ensure on the next send.
              // Only gate the composer on history load, not on streaming: the
              // user can keep drafting while the Send button is replaced by
              // Stop. The Agent selector remains locked by the thread's
              // 1-thread-1-binding contract; only the draft carries forward.
              disabled={!isHistoryLoaded}
            />
          </div>
        </div>
      </SidebarPanel>
    </ChatSessionProvider>
  );
};
