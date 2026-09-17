// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import clsx from 'clsx';
import { Bookmark, ListIndentIncrease, PanelRightOpen } from 'lucide-react';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';

import {
  createId,
  getQuestionNodeStatus,
  MODE_SELECTION_ID,
  MODEL_SELECTION_ID,
} from '@huabu/shared';

import {
  materializeDiscoveredAgent,
  setAcpSessionConfigOption,
  setAcpSessionMode,
  setAcpSessionModel,
} from '@/api/acp';
import { Button } from '@/components/Common/Button';
import { TextInput } from '@/components/Common/TextInput';
import { toast } from '@/components/Common/Toast';
import { PermissionTray } from '@/components/Messages/AIMessage/PermissionCard';
import { useAcpProfiles } from '@/hooks/useAcpProfiles';
import { useAcpSessionMeta } from '@/hooks/useAcpSessionMeta';
import { useAcpSlashCommands } from '@/hooks/useAcpSlashCommands';
import { useActivelyViewingQuestionNode } from '@/hooks/useActivelyViewingQuestion';
import { useBuiltinThreadSettings } from '@/hooks/useBuiltinThreadSettings';
import { ChatSessionProvider, type ChatSession } from '@/hooks/useChatSession';
import { useInternalSlashCommands } from '@/hooks/useInternalSlashCommands';
import { useAcpDiscoveryStore } from '@/store/acpDiscoveryStore';
import { useAcpProfilesStore } from '@/store/acpProfilesStore';
import { useAcpThreadChangesStore } from '@/store/acpThreadChangesStore';
import useCanvasStore from '@/store/canvasStore';
import { useChatPreferencesStore } from '@/store/chatPreferencesStore';
import {
  selectThreadBinding,
  selectThreadHistoryLoaded,
  selectThreadHistoryPageState,
  selectThreadLastAction,
  selectThreadLaunchOverrides,
  selectThreadMessages,
  useChatStore,
} from '@/store/chatStore';
import { findPendingPermissionRequest } from '@/store/chatTypes';
import {
  acknowledgeConversationResult,
  awaitConversationDraft,
  saveConversationDraft,
  resolveConversationAgentBinding,
  resolveConversationLaunchOverrides,
  resolveConversationOwnerSource,
} from '@/store/conversationOwner';
import {
  conversationTitleKey,
  clearPendingConversationTitle,
  getConversationTitle,
  retryConversationTitle,
  renameConversationTitle,
  useConversationTitleStore,
} from '@/store/conversationTitleStore';
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
import { AgentWorkingDirectory } from './AgentWorkingDirectory';
import { BuiltinSessionSelectors } from './BuiltinSessionSelectors';
import { ChangeReviewCard } from './ChangeReviewCard';
import { parseSlashInvocations } from './parseSlashInvocations';
import { saveChatAsQuestion } from './saveChatAsQuestion';
import { ThreadChatInput } from './ThreadChatInput';
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

  const viewingQuestionNodeId =
    activeConversationView?.conversationOwner.nodeId;
  const conversationOwnerSource = useCanvasStore((state) =>
    resolveConversationOwnerSource(
      state.canvasId,
      state.nodes,
      activeConversationView,
    ),
  );
  const ownerScopeReady =
    !activeConversationView || conversationOwnerSource !== undefined;
  // "Composing" = the viewed question node has never been authored/run yet
  // (its status is still `idle`). Its binding remains mutable unless creation
  // explicitly fixed it; the mode follows this thread's inline pick rather
  // than the node's
  // not-yet-written `agentMode`. Derived from the node itself — the single
  // source of truth — rather than a stored `compose` flag. Replay (already-run
  // node) keeps deriving from the node.
  const isComposingQuestion =
    !!viewingQuestionNodeId &&
    getQuestionNodeStatus(conversationOwnerSource) === 'idle';
  const questionReplayMode = (() => {
    if (!viewingQuestionNodeId || !conversationOwnerSource) return undefined;
    const d = conversationOwnerSource;
    return d.agentBinding?.kind === 'external' ? 'ask' : (d.agentMode ?? 'ask');
  })();
  const viewingQuestionBindingIsFixed =
    conversationOwnerSource?.agentBindingPolicy === 'fixed' ||
    conversationOwnerSource?.bindingState === 'bound';
  const [savingAgentDraft, setSavingAgentDraft] = useState(false);
  const activelyViewingOwner = useActivelyViewingQuestionNode(
    activeConversationView?.presentationAnchor.nodeId ?? '',
  );
  const observedToken = conversationOwnerSource?.invocationToken;
  const observedStatus = conversationOwnerSource?.status;
  const observedViewed = conversationOwnerSource?.viewed;
  useEffect(() => {
    if (!activeConversationView || !activelyViewingOwner) return;
    void acknowledgeConversationResult(activeConversationView, {
      invocationToken: observedToken,
      status: observedStatus,
      viewed: observedViewed,
    }).catch((error) =>
      console.error('Failed to acknowledge Agent result', error),
    );
  }, [
    activeConversationView,
    activelyViewingOwner,
    observedToken,
    observedStatus,
    observedViewed,
  ]);
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
  const isViewingUserNamedQuestion =
    conversationOwnerSource?.labelSource === 'user';
  const tryRename = useCanvasStore((s) => s.tryRename);
  const canRenameQuestion = ownerScopeReady;
  const titleKey = conversationTitleKey(ownerCanvasId, threadId);
  const cachedTitle = useConversationTitleStore(
    (state) => getConversationTitle(ownerCanvasId, threadId, state).title,
  );
  const titleError = useConversationTitleStore(
    (state) => state.entries[titleKey]?.error,
  );
  const editableTitle = viewingQuestionNodeId
    ? viewingQuestionLabel
    : cachedTitle;
  const renameTitleLabel = t(
    viewingQuestionNodeId ? 'node.rename' : 'chat.renameTitle',
  );
  const [isEditingQuestionTitle, setIsEditingQuestionTitle] = useState(false);
  const [draftQuestionTitle, setDraftQuestionTitle] = useState(
    editableTitle ?? '',
  );
  const questionTitleInputRef = useRef<HTMLInputElement>(null);
  const titleEditActive = useRef(false);
  const titleIdentity = `${titleKey}:${viewingQuestionNodeId ?? ''}`;
  const currentTitleIdentity = useRef(titleIdentity);
  currentTitleIdentity.current = titleIdentity;
  const [savingTitleIdentity, setSavingTitleIdentity] = useState<string | null>(
    null,
  );
  const isSavingTitle = savingTitleIdentity === titleIdentity;

  useEffect(() => {
    if (isEditingQuestionTitle) return;
    setDraftQuestionTitle(editableTitle ?? '');
  }, [isEditingQuestionTitle, editableTitle]);

  useEffect(() => {
    setIsEditingQuestionTitle(false);
    titleEditActive.current = false;
    currentTitleIdentity.current = titleIdentity;
    return () => {
      if (currentTitleIdentity.current === titleIdentity) {
        currentTitleIdentity.current = '';
      }
    };
  }, [titleIdentity]);

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
  const loadOlderHistory = useChatHistory(
    session,
    setIsLoading,
    previewTabId,
  )?.loadOlderHistory;

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
  const historyPage = useChatStore(
    useShallow((state) => selectThreadHistoryPageState(state, threadId)),
  );
  const recentTurnCount = useChatPreferencesStore(
    (state) => state.recentTurnCount,
  );
  const addNode = useCanvasStore((state) => state.addNode);
  const llmConfig = useLLMStore((state) => state.config);
  const llmLoading = useLLMStore((state) => state.loading);
  const llmInit = useLLMStore((state) => state.init);

  // Thread → agent binding. The binding is locked for the lifetime of
  // a thread; the only way to change it is to open a new workspace Chat.
  const cachedAgentBinding = useChatStore((state) =>
    selectThreadBinding(state, threadId),
  );
  // Established Question conversations keep binding identity on their owner
  // node, while the thread cache deliberately stops persisting that mirror.
  // Resolve the owner synchronously so refresh never renders or dispatches a
  // follow-up through the built-in fallback before the cache is rehydrated.
  const agentBinding = resolveConversationAgentBinding(
    conversationOwnerSource,
    cachedAgentBinding,
  );
  const cachedLaunchOverrides = useChatStore((state) =>
    selectThreadLaunchOverrides(state, threadId),
  );
  const launchOverrides = resolveConversationLaunchOverrides(
    conversationOwnerSource,
    cachedLaunchOverrides,
  );
  const setThreadLaunchOverrides = useChatStore(
    (state) => state.setThreadLaunchOverrides,
  );
  const setAgentBinding = useChatStore((state) => state.setAgentBinding);
  const makeThreadMetadataEphemeral = useChatStore(
    (state) => state.makeThreadMetadataEphemeral,
  );
  const {
    profiles: acpProfiles,
    refresh: refreshAcpProfiles,
    agentlet: acpAgentlet,
  } = useAcpProfiles();
  const discoveryMachines = useAcpDiscoveryStore((state) => state.machines);
  const discoveryLoaded = useAcpDiscoveryStore((state) => state.loaded);
  const discoveryLoading = useAcpDiscoveryStore((state) => state.loading);
  const initDiscovery = useAcpDiscoveryStore((state) => state.init);
  const refreshDiscovery = useAcpDiscoveryStore((state) => state.refresh);
  useEffect(() => {
    if (agentBinding.kind === 'external') void initDiscovery();
  }, [agentBinding.kind, initDiscovery]);
  const selectedProfile =
    agentBinding.kind === 'external'
      ? acpProfiles.find((profile) => profile.id === agentBinding.profileId)
      : undefined;

  useEffect(() => {
    if (bindingsEqual(cachedAgentBinding, agentBinding)) {
      return;
    }
    makeThreadMetadataEphemeral(threadId);
    setAgentBinding(threadId, agentBinding);
  }, [
    agentBinding,
    cachedAgentBinding,
    makeThreadMetadataEphemeral,
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
  // the first explicit interaction surfaces a clear error.
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
    source: acpSessionMetaSource,
    realization: acpRealization,
    loading: acpSessionMetaLoading,
    error: acpSessionMetaError,
    refresh: refreshAcpSessionMeta,
    applyOptimistic: applyAcpSessionMetaOptimistic,
  } = useAcpSessionMeta({
    threadId,
    binding: agentBinding,
    canvasId: ownerCanvasId,
    enabled: ownerScopeReady && acpExternalReachable,
  });
  const selectedAgentletId =
    acpRealization.state === 'realized'
      ? acpRealization.agentletId
      : selectedProfile?.agentletId;
  const selectedMachine = discoveryMachines.find(
    (machine) => machine.agentletId === selectedAgentletId,
  );

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
    threadHasMessages: activeConversationView
      ? conversationOwnerSource?.bindingState === 'bound'
      : messages.length > 0,
  });

  // Show only positive connection evidence. Cached ACP metadata is not proof
  // of a live session, so the healthy/unknown state intentionally has no
  // optimistic green badge.
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
      : acpSessionMetaLoading ||
          discoveryLoading ||
          !discoveryLoaded ||
          selectedMachine?.discovery === 'refreshing'
        ? 'connecting'
        : (selectedMachine && !selectedMachine.connected) ||
            selectedMachine?.discovery === 'unsupported' ||
            selectedMachine?.discovery === 'error' ||
            (!!selectedAgentletId && !selectedMachine && discoveryLoaded) ||
            (!selectedProfile && acpRealization.state !== 'realized') ||
            (!selectedMachine && acpAgentlet?.online === false) ||
            (acpSessionMetaError && acpSessionMeta.updatedAt === 0)
          ? 'failed'
          : null;

  // Optimistic onChange handlers for the ACP selectors: merge the
  // chosen value into the local snapshot immediately, then fire the
  // REST set-RPC. On failure, revert the snapshot and surface a toast
  // so the user knows the agent rejected the change.
  //
  // Spawn context threaded into every set-RPC: the selector dropdowns
  // are seeded from the no-spawn cached-meta snapshot, so the user can
  // switch a value before the session has ever been opened. Passing
  // `{ binding, canvasId }` lets the server realize the complete workload
  // and open its session
  // on-demand instead of rejecting the switch with `session_not_found`.
  const acpControlTarget = useMemo(
    () => ({
      binding: agentBinding.kind === 'external' ? agentBinding : undefined,
      canvasId: ownerCanvasId ?? undefined,
      cwd: launchOverrides?.workingDirPath,
    }),
    [agentBinding, launchOverrides?.workingDirPath, ownerCanvasId],
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
        if (activeConversationView)
          await awaitConversationDraft(activeConversationView);
        if (!acpControlTarget.binding) return;
        await setAcpSessionMode(threadId, {
          modeId,
          binding: acpControlTarget.binding,
          canvasId: acpControlTarget.canvasId,
          cwd: acpControlTarget.cwd,
        });
        await refreshAcpSessionMeta();
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
    [
      threadId,
      applyAcpSessionMetaOptimistic,
      acpControlTarget,
      activeConversationView,
      refreshAcpSessionMeta,
      onCommit,
      t,
    ],
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
        if (activeConversationView)
          await awaitConversationDraft(activeConversationView);
        if (!acpControlTarget.binding) return;
        await setAcpSessionModel(threadId, {
          modelId,
          binding: acpControlTarget.binding,
          canvasId: acpControlTarget.canvasId,
          cwd: acpControlTarget.cwd,
        });
        await refreshAcpSessionMeta();
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
    [
      threadId,
      applyAcpSessionMetaOptimistic,
      acpControlTarget,
      activeConversationView,
      refreshAcpSessionMeta,
      onCommit,
      t,
    ],
  );

  const handleAcpSelectConfigOption = useCallback(
    async (optionId: string, value: string | boolean) => {
      if (!threadId) return;
      const previous = acpSessionMetaRef.current.selections[optionId] ?? null;
      applyAcpSessionMetaOptimistic({
        selection: { id: optionId, value },
      });
      try {
        if (activeConversationView)
          await awaitConversationDraft(activeConversationView);
        if (!acpControlTarget.binding) return;
        await setAcpSessionConfigOption(threadId, {
          configOptionId: optionId,
          value,
          binding: acpControlTarget.binding,
          canvasId: acpControlTarget.canvasId,
          cwd: acpControlTarget.cwd,
        });
        await refreshAcpSessionMeta();
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
    [
      threadId,
      applyAcpSessionMetaOptimistic,
      acpControlTarget,
      activeConversationView,
      refreshAcpSessionMeta,
      onCommit,
      t,
    ],
  );

  useEffect(() => {
    if (!llmConfig && !llmLoading) {
      void llmInit();
    }
  }, [llmConfig, llmLoading, llmInit]);

  const panelTitle = useMemo(() => {
    if (activeConversationView) {
      if (isComposingQuestion && !isViewingUserNamedQuestion) {
        return t('chat.newQuestion');
      }
      return viewingQuestionLabel ?? t('chat.question');
    }
    return cachedTitle || t('chat.newConversation');
  }, [
    cachedTitle,
    t,
    activeConversationView,
    isComposingQuestion,
    isViewingUserNamedQuestion,
    viewingQuestionLabel,
  ]);

  const commitQuestionTitle = useCallback(() => {
    // Enter unmounts the field and may also deliver blur before React commits.
    if (!titleEditActive.current) return;
    titleEditActive.current = false;
    const next = draftQuestionTitle.trim();
    setIsEditingQuestionTitle(false);
    if (!next || next === (editableTitle ?? '').trim()) {
      setDraftQuestionTitle(editableTitle ?? '');
      return;
    }
    if (next.length > 120) return;
    setSavingTitleIdentity(titleIdentity);
    const save = viewingQuestionNodeId
      ? tryRename('node', viewingQuestionNodeId, next)
      : renameConversationTitle(
          ownerCanvasId,
          threadId,
          next,
          isHistoryLoaded &&
            !isLoading &&
            !messages.some((message) => message.role === 'user'),
        ).then(() => true);
    void save
      .then((accepted) => {
        if (currentTitleIdentity.current !== titleIdentity) return;
        if (accepted) onCommit?.();
        else setDraftQuestionTitle(editableTitle ?? '');
      })
      .catch((error: unknown) => {
        if (currentTitleIdentity.current !== titleIdentity) return;
        setDraftQuestionTitle(editableTitle ?? '');
        toast(
          error instanceof Error ? error.message : t('chat.titleSaveFailed'),
          { tone: 'danger' },
        );
      })
      .finally(() => {
        setSavingTitleIdentity((current) =>
          current === titleIdentity ? null : current,
        );
      });
  }, [
    draftQuestionTitle,
    editableTitle,
    titleIdentity,
    ownerCanvasId,
    threadId,
    isHistoryLoaded,
    isLoading,
    messages,
    t,
    onCommit,
    tryRename,
    viewingQuestionNodeId,
  ]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent, agentMode: AgentMode, draft: string) => {
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
      const raw = draft;
      useChatStore.getState().setDraft(threadId, '');
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
    },
    [agentBinding.kind, knownSlashIds, onCommit, startStream, threadId],
  );

  const handleRetry = useCallback(() => {
    const lastUserMsg = [...messages]
      .reverse()
      .find((message) => message.role === 'user');
    if (lastUserMsg?.role === 'user') {
      void startStream(lastUserMsg.content, mode);
    }
  }, [messages, mode, startStream]);

  // Inline agent selector (left of the chat input toolbar). The binding
  // is mutable only while the thread has no user message yet — once a
  // turn is sent, 1-thread-1-binding locks it and the selector renders
  // read-only. Picking an agent rebinds the *current* (empty) thread in
  // place; it never mints a new thread.
  const threadHasUserMessage = messages.some((m) => m.role === 'user');
  const agentSelectorEditable =
    !viewingQuestionBindingIsFixed &&
    (activeConversationView
      ? conversationOwnerSource?.bindingState !== 'bound'
      : !threadHasUserMessage) &&
    acpRealization.state !== 'realized' &&
    !acpSessionMetaLoading &&
    ownerScopeReady &&
    !savingAgentDraft &&
    !isLoading;
  const handleWorkingDirectoryChange = useCallback(
    async (workingDirPath: string | undefined) => {
      const next = workingDirPath ? { workingDirPath } : undefined;
      if (activeConversationView) {
        setSavingAgentDraft(true);
        try {
          await saveConversationDraft(activeConversationView, {
            agentBinding,
            agentMode: mode,
            agentLaunchOverrides: next ?? {},
          });
          makeThreadMetadataEphemeral(threadId, { preserveSettings: true });
        } finally {
          setSavingAgentDraft(false);
        }
      }
      setThreadLaunchOverrides(threadId, next);
      onCommit?.();
    },
    [
      activeConversationView,
      agentBinding,
      makeThreadMetadataEphemeral,
      mode,
      onCommit,
      setThreadLaunchOverrides,
      threadId,
    ],
  );
  const handleSelectAgent = useCallback(
    async (choice: AgentChoice) => {
      // Agent binding is immutable once a turn starts (1 thread = 1 binding).
      // The selector is already read-only then; keep this guard as defense in
      // depth in case a stale menu event arrives during the transition.
      if (!agentSelectorEditable) return;
      setSavingAgentDraft(true);
      try {
        let binding = choice.binding;
        if (choice.discoveredAgent) {
          const profile = await materializeDiscoveredAgent({
            agentletId: choice.discoveredAgent.agentletId,
            harnessId: choice.discoveredAgent.harnessId,
          });
          binding = {
            kind: 'external',
            profileId: profile.id,
            alias: profile.alias,
          };
          await refreshAcpProfiles();
        }
        if (!binding) return;
        if (activeConversationView) {
          await saveConversationDraft(activeConversationView, {
            agentBinding: binding,
            agentMode: choice.mode,
            agentIcon: snapshotAgentIcon(
              binding,
              useAcpProfilesStore.getState().profiles,
            ),
          });
          makeThreadMetadataEphemeral(threadId, { preserveSettings: true });
        }
        setAgentBinding(threadId, binding, canvasId || undefined);
        setThreadLastAction(threadId, choice.mode);
        onCommit?.();
      } catch (error) {
        toast(
          error instanceof Error
            ? error.message
            : t('chat.materializeAgentFailed'),
          { tone: 'danger' },
        );
      } finally {
        setSavingAgentDraft(false);
      }
    },
    [
      agentSelectorEditable,
      activeConversationView,
      makeThreadMetadataEphemeral,
      onCommit,
      refreshAcpProfiles,
      setAgentBinding,
      setThreadLastAction,
      canvasId,
      threadId,
      t,
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
    const saved = saveChatAsQuestion(
      {
        id: questionNodeId,
        nodeType: 'question',
        data: {
          type: 'question',
          content,
          threadId,
          agentBinding,
          agentIcon: snapshotAgentIcon(
            agentBinding,
            useAcpProfilesStore.getState().profiles,
          ),
          agentMode: mode,
          ...(launchOverrides ? { agentLaunchOverrides: launchOverrides } : {}),
        },
      },
      {
        canvasId,
        previewTabId,
        conversationTitle: getConversationTitle(ownerCanvasId, threadId),
        addNode,
        nodeExists: (nodeId) =>
          useCanvasStore.getState().nodes.some((node) => node.id === nodeId),
        replaceTabTarget: (tabId, target) =>
          usePreviewWorkspaceStore.getState().replaceTabTarget(tabId, target),
      },
    );
    if (saved) clearPendingConversationTitle(ownerCanvasId, threadId);
  }, [
    isLoading,
    messages,
    threadId,
    agentBinding,
    launchOverrides,
    mode,
    canvasId,
    addNode,
    previewTabId,
    ownerCanvasId,
  ]);

  return (
    <ChatSessionProvider value={session}>
      <SidebarPanel
        title={panelTitle}
        tabs={
          <span className="flex max-w-full min-w-0 flex-1 items-center gap-1">
            {canRenameQuestion && isEditingQuestionTitle ? (
              <TextInput
                ref={questionTitleInputRef}
                value={draftQuestionTitle}
                maxLength={120}
                aria-label={renameTitleLabel}
                placeholder={t('node.untitled')}
                className="text-fg-default bg-bg-default border-edge-default w-64 max-w-full min-w-0 shrink basis-auto truncate rounded border px-1 py-0.5 text-sm font-semibold outline-none"
                onChange={(event) => setDraftQuestionTitle(event.target.value)}
                onBlur={commitQuestionTitle}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === 'Enter') {
                    if (event.nativeEvent.isComposing) return;
                    event.preventDefault();
                    commitQuestionTitle();
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    titleEditActive.current = false;
                    setDraftQuestionTitle(editableTitle ?? '');
                    setIsEditingQuestionTitle(false);
                  }
                }}
              />
            ) : canRenameQuestion ? (
              <Button
                variant="ghost"
                size="sm"
                title={panelTitle}
                aria-label={renameTitleLabel}
                tooltipPlacement="bottom"
                tooltipWrapperClassName="inline-flex max-w-full min-w-0 shrink basis-auto"
                className={clsx(
                  'hover:text-fg-default max-w-full min-w-0 shrink cursor-text justify-start rounded border border-transparent px-1 py-0.5 text-sm font-semibold',
                )}
                disabled={isSavingTitle || !isHistoryLoaded}
                onClick={() => {
                  titleEditActive.current = true;
                  setIsEditingQuestionTitle(true);
                }}
              >
                <span className="max-w-full min-w-0 truncate">
                  {panelTitle}
                </span>
              </Button>
            ) : (
              <span
                className="max-w-full min-w-0 shrink truncate px-1 py-0.5"
                title={panelTitle}
              >
                {panelTitle}
              </span>
            )}
            {acpConnectionStatus && agentBinding.kind === 'external' && (
              <AcpConnectionBadge
                status={acpConnectionStatus}
                alias={agentBinding.alias}
                errorMessage={acpSessionMetaError?.message ?? null}
              />
            )}
          </span>
        }
        isCollapsed={isCollapsed}
        onToggle={onToggle}
        iconCollapsed={<PanelRightOpen size={16} />}
        iconExpanded={<ListIndentIncrease size={16} />}
        compactHeader
        tools={
          activeConversationView ? null : (
            <Button
              variant="ghost"
              tone="neutral"
              size="md"
              iconOnly
              onClick={handleSaveChat}
              disabled={
                !isHistoryLoaded || isLoading || isSavingTitle || !canSave
              }
              title={t('chat.saveAsQuestion')}
              tooltipPlacement="bottom"
            >
              <Bookmark />
            </Button>
          )
        }
      >
        <div className="flex h-full flex-col gap-2 overflow-visible pt-3">
          {!activeConversationView && titleError && (
            <div
              role="alert"
              className="text-danger flex items-center gap-2 px-3 text-xs"
            >
              <span>
                {t('chat.titleSaveFailed')}: {titleError}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void retryConversationTitle(ownerCanvasId, threadId);
                }}
              >
                {t('messages.retry')}
              </Button>
            </div>
          )}
          <MessageList
            messages={messages}
            isLoading={isLoading}
            isHistoryLoading={!isHistoryLoaded}
            hasOlderHistory={historyPage.hasOlderHistory}
            olderTurnBatchSize={recentTurnCount}
            isLoadingOlderHistory={historyPage.isLoadingOlderHistory}
            olderHistoryError={historyPage.olderHistoryError ?? undefined}
            onLoadOlderHistory={loadOlderHistory}
            viewKey={messageListViewKey(ownerCanvasId, threadId)}
            isActive={!isCollapsed}
            openPosition={
              pendingPermission
                ? 'bottom'
                : (openPositionRequest?.position ?? 'bottom')
            }
            openPositionRequestNonce={openPositionRequest?.nonce}
            onOpenPositionHandled={onOpenPositionHandled}
            onRetry={handleRetry}
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
            {ownerCanvasId && threadId ? (
              <ChangeReviewCard canvasId={ownerCanvasId} threadId={threadId} />
            ) : null}
            <ThreadChatInput
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
                <div className="flex min-w-0 items-center">
                  <AgentSelector
                    currentBinding={agentBinding}
                    currentMode={mode}
                    profiles={acpProfiles}
                    machines={discoveryMachines}
                    editable={agentSelectorEditable}
                    onSelect={handleSelectAgent}
                    onRefreshProfiles={refreshAcpProfiles}
                    onRefreshDiscovery={refreshDiscovery}
                    disabled={!isHistoryLoaded}
                    fallbackIcon={viewingQuestionAgentIcon}
                  />
                  {(selectedProfile?.launch.kind === 'acp-command' ||
                    acpRealization.state === 'realized') && (
                    <AgentWorkingDirectory
                      agentletId={
                        acpRealization.state === 'realized'
                          ? acpRealization.agentletId
                          : (selectedProfile?.agentletId ?? '')
                      }
                      profileWorkingDirPath={
                        selectedProfile?.workingDirPath ??
                        (acpRealization.state === 'realized'
                          ? (acpRealization.workingDirPath ?? '')
                          : '')
                      }
                      overrideWorkingDirPath={launchOverrides?.workingDirPath}
                      realization={acpRealization}
                      readOnly={viewingQuestionBindingIsFixed}
                      disabled={
                        !isHistoryLoaded || isLoading || acpSessionMetaLoading
                      }
                      onChange={handleWorkingDirectoryChange}
                    />
                  )}
                </div>
              }
              acpSelectorsSlot={
                agentBinding.kind === 'external' ? (
                  <AcpSessionSelectors
                    meta={acpSessionMeta}
                    source={acpSessionMetaSource}
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
