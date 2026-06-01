import {
  ArrowLeft,
  ListIndentIncrease,
  PanelRightOpen,
  Plus,
} from 'lucide-react';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';

import { SidebarPanel } from '../SidebarPanel';
import { AcpSessionSelectors } from './AcpSessionSelectors';
import { ChatInput } from './ChatInput';
import { ModeSelector } from './ModeSelector';
import { parseSlashInvocations } from './parseSlashInvocations';
import { useSketchClusterMessages } from './useSketchClusterMessages';
import { useAgentStream } from '../../../hooks/useAgentStream';
import { useChatHistory } from '../../../hooks/useChatHistory';
import { MessageList } from '../../Messages/MessageList';

import type { AgentMode, IntentCandidate } from '@sediment/shared';

import {
  setAcpSessionConfigOption,
  setAcpSessionMode,
  setAcpSessionModel,
} from '@/api/acp';
import { Button } from '@/components/Common/Button';
import { toast } from '@/components/Common/Toast';
import { useAcpAgents } from '@/hooks/useAcpAgents';
import { useAcpSessionMeta } from '@/hooks/useAcpSessionMeta';
import { useAcpSlashCommands } from '@/hooks/useAcpSlashCommands';
import { useInternalSlashCommands } from '@/hooks/useInternalSlashCommands';
import useCanvasStore from '@/store/canvasStore';
import { useChatStore } from '@/store/chatStore';
import { useIntentStore } from '@/store/intentStore';
import { useLLMStore } from '@/store/llmStore';

interface ChatPanelProps {
  isCollapsed?: boolean;
  onToggle?: () => void;
}

export const ChatPanel = ({ isCollapsed, onToggle }: ChatPanelProps) => {
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<AgentMode>('ask');

  // Agent stream hook — manages streaming and loading state
  const { isLoading, setIsLoading, startStream, stopStream } = useAgentStream();

  // Chat history hook — loads history and handles reconnection
  useChatHistory(setIsLoading);

  // Persistent chat state
  const messages = useChatStore((state) => state.messages);
  const isHistoryLoaded = useChatStore((state) => state.isHistoryLoaded);
  const updateMessage = useChatStore((state) => state.updateMessage);
  const clearMessages = useChatStore((state) => state.clearMessages);
  const canvasId = useCanvasStore((state) => state.canvasId);
  const llmConfig = useLLMStore((state) => state.config);
  const llmModels = useLLMStore((state) => state.models);
  const llmLoading = useLLMStore((state) => state.loading);
  const llmInit = useLLMStore((state) => state.init);

  // Thread → agent binding. The binding is locked for the lifetime of
  // a thread; the picker is only writable on an empty, not-streaming
  // thread. New threads start in `{kind:'internal'}`.
  const agentBinding = useChatStore((state) => state.agentBinding);
  const setAgentBinding = useChatStore((state) => state.setAgentBinding);
  const threadId = useChatStore((state) => state.threadId);
  const {
    agents: connectedAgents,
    refresh: refreshAcpAgents,
    loading: acpAgentsLoading,
    enabled: acpBridgeEnabled,
  } = useAcpAgents();

  // Gate the ACP per-thread hooks on the bound agent actually being
  // present in the connected-agents list. Without this gate a thread
  // whose persisted binding refers to a now-disconnected agent (bridge
  // restart, agent process exited, etc.) would still POST
  // /api/acp/threads/<id>/session at mount and reliably get a 503,
  // which clutters the console and confuses debugging. The
  // ModeSelector resets the binding to internal on unlocked threads
  // (see ModeSelector.tsx), but the meta/slash-commands hooks still
  // fire one render earlier than the reset — `acpExternalReachable`
  // is what keeps that initial fetch from happening.
  const acpExternalReachable =
    agentBinding.kind === 'external' &&
    connectedAgents.some((a) => a.agentId === agentBinding.agentletAgentId);

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
    canvasId,
    enabled: acpExternalReachable,
  });
  const internalSlash = useInternalSlashCommands({
    binding: agentBinding,
    scope: mode,
    enabled: agentBinding.kind === 'internal' && mode === 'operate',
  });
  const slashCommands = acpExternalReachable
    ? acpSlash.commands
    : internalSlash.commands;
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
  const {
    meta: acpSessionMeta,
    applyEvent: applyAcpSessionMetaEvent,
    applyOptimistic: applyAcpSessionMetaOptimistic,
  } = useAcpSessionMeta({
    threadId,
    binding: agentBinding,
    canvasId,
    enabled: acpExternalReachable,
  });

  // Keep a ref to the latest snapshot so the optimistic handlers can
  // read prior values for revert without re-creating themselves (and
  // their downstream consumers) on every meta tick.
  const acpSessionMetaRef = useRef(acpSessionMeta);
  useEffect(() => {
    acpSessionMetaRef.current = acpSessionMeta;
  }, [acpSessionMeta]);

  // Optimistic onChange handlers for the ACP selectors: merge the
  // chosen value into the local snapshot immediately, then fire the
  // REST set-RPC. On failure, revert the snapshot and surface a toast
  // so the user knows the agent rejected the change.
  const handleAcpSelectMode = useCallback(
    async (modeId: string) => {
      if (!threadId) return;
      const previousModeId = acpSessionMetaRef.current.currentModeId;
      if (previousModeId === modeId) return;
      applyAcpSessionMetaEvent({
        type: 'session_mode_update',
        data: { currentModeId: modeId },
      });
      try {
        await setAcpSessionMode(threadId, { modeId });
      } catch (err) {
        applyAcpSessionMetaOptimistic({ currentModeId: previousModeId });
        toast(
          err instanceof Error
            ? `Failed to switch mode: ${err.message}`
            : 'Failed to switch mode',
          { variant: 'error' },
        );
      }
    },
    [threadId, applyAcpSessionMetaEvent, applyAcpSessionMetaOptimistic],
  );

  const handleAcpSelectModel = useCallback(
    async (modelId: string) => {
      if (!threadId) return;
      const previousModelId = acpSessionMetaRef.current.currentModelId;
      if (previousModelId === modelId) return;
      applyAcpSessionMetaOptimistic({ currentModelId: modelId });
      try {
        await setAcpSessionModel(threadId, { modelId });
      } catch (err) {
        applyAcpSessionMetaOptimistic({ currentModelId: previousModelId });
        toast(
          err instanceof Error
            ? `Failed to switch model: ${err.message}`
            : 'Failed to switch model',
          { variant: 'error' },
        );
      }
    },
    [threadId, applyAcpSessionMetaOptimistic],
  );

  const handleAcpSelectConfigOption = useCallback(
    async (optionId: string, value: string | boolean) => {
      if (!threadId) return;
      const priorOption = acpSessionMetaRef.current.configOptions.find(
        (o) => String((o as { id?: unknown }).id ?? '') === optionId,
      );
      const previousValue = (
        priorOption as { currentValue?: unknown } | undefined
      )?.currentValue;
      const previousValueTyped =
        typeof previousValue === 'string' || typeof previousValue === 'boolean'
          ? previousValue
          : undefined;
      if (previousValueTyped === value) return;
      applyAcpSessionMetaOptimistic({ configOption: { id: optionId, value } });
      try {
        await setAcpSessionConfigOption(threadId, {
          configOptionId: optionId,
          value,
        });
      } catch (err) {
        if (previousValueTyped !== undefined) {
          applyAcpSessionMetaOptimistic({
            configOption: { id: optionId, value: previousValueTyped },
          });
        }
        toast(
          err instanceof Error
            ? `Failed to update option: ${err.message}`
            : 'Failed to update option',
          { variant: 'error' },
        );
      }
    },
    [threadId, applyAcpSessionMetaOptimistic],
  );

  // Question thread replay mode
  const viewingQuestionThread = useChatStore((s) => s.viewingQuestionThread);
  const closeQuestionThread = useChatStore((s) => s.closeQuestionThread);

  // Sketch cluster inspector mode (mutually exclusive with question
  // replay). When set, MessageList renders synthesized messages built from
  // the live cluster state instead of the canvas chat.
  const viewingSketchCluster = useChatStore((s) => s.viewingSketchCluster);
  const closeSketchCluster = useChatStore((s) => s.closeSketchCluster);
  const sketchMessages = useSketchClusterMessages(
    viewingSketchCluster?.clusterId ?? null,
  );

  useEffect(() => {
    if (!llmConfig && !llmLoading) {
      void llmInit();
    }
  }, [llmConfig, llmLoading, llmInit]);

  const activeModelName = useMemo(() => {
    const activeModelId = llmConfig?.model?.trim();
    if (!activeModelId) return '';
    const matchedModel = llmModels.find((m) => m.id === activeModelId);
    return matchedModel?.name?.trim() || activeModelId;
  }, [llmConfig?.model, llmModels]);

  const panelTitle = useMemo(() => {
    if (viewingSketchCluster) return 'Sketch Recognition';
    if (viewingQuestionThread) return 'Question Replay';
    // When the thread is delegated to an external ACP agent, the
    // built-in model name is irrelevant — surface the agent alias
    // instead so the header reflects who's actually answering.
    if (agentBinding.kind === 'external') {
      return `Chat with ${agentBinding.alias}`;
    }
    return activeModelName ? `Chat with ${activeModelName}` : 'Chat';
  }, [
    activeModelName,
    agentBinding,
    viewingQuestionThread,
    viewingSketchCluster,
  ]);

  // Register intent callback — when user selects an intent in the popover,
  // it's sent here and executed as an agent chat message.
  useEffect(() => {
    const handleIntentChosen = async (
      intent: string,
      candidates: IntentCandidate[],
    ) => {
      // Open the chat panel if collapsed
      if (isCollapsed && onToggle) {
        onToggle();
      }
      // Switch mode to operate
      setMode('operate');
      // Send as operate mode message with intent-select widget.
      // Return the promise so callers (e.g. sketch recognition) can
      // await agent completion before cleaning up.
      await startStream(intent, 'operate', {
        candidates,
        selectedIntent: intent,
      });
    };
    useIntentStore.getState()._setOnIntentChosen(handleIntentChosen);
    return () => {
      useIntentStore.getState()._setOnIntentChosen(null);
    };
  }, [startStream, isCollapsed, onToggle]);

  const handleIntentReselect = useCallback(
    (messageId: string, intent: string) => {
      // Update the intent-select message with the new selection
      updateMessage(messageId, (m) =>
        m.role === 'intent-select' ? { ...m, selectedIntent: intent } : m,
      );
      // Re-run with the new intent
      void startStream(intent, 'operate');
    },
    [startStream, updateMessage],
  );

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
      await startStream(prompt, agentMode);
      return;
    }
    const { invokedSkills, message } = parseSlashInvocations(
      raw,
      knownSlashIds,
    );
    const prompt = message.trim();
    if (!prompt) return;
    await startStream(
      prompt,
      agentMode,
      undefined,
      invokedSkills.length > 0 ? invokedSkills : undefined,
    );
  };

  const handleNewChat = () => {
    if (isLoading) return;
    clearMessages(canvasId || undefined);
  };

  return (
    <SidebarPanel
      title={panelTitle}
      tabs={
        // Sketch / question replay are read-only views — keep the
        // descriptive title there. The normal chat view promotes the
        // binding picker into the header (ChatGPT-style) so it reads
        // as "which agent owns this thread", separating it visually
        // from the per-turn ACP session selectors in ChatInput.
        viewingSketchCluster || viewingQuestionThread ? (
          <span className="block min-w-0 flex-1 truncate" title={panelTitle}>
            {panelTitle}
          </span>
        ) : (
          <ModeSelector
            mode={mode}
            onModeChange={setMode}
            binding={agentBinding}
            onBindingChange={(b) => setAgentBinding(b, canvasId || undefined)}
            connectedAgents={connectedAgents}
            onRefreshAgents={refreshAcpAgents}
            refreshing={acpAgentsLoading}
            agentsListReady={acpBridgeEnabled !== null}
            onNewThread={handleNewChat}
            locked={messages.length > 0 || isLoading}
            disabled={!isHistoryLoaded}
          />
        )
      }
      isCollapsed={isCollapsed}
      onToggle={onToggle}
      iconCollapsed={<PanelRightOpen size={16} />}
      iconExpanded={<ListIndentIncrease size={16} />}
      className="border-l border-[#eeece7]"
      tools={
        viewingSketchCluster ? (
          <Button
            variant="ghost"
            iconOnly
            onClick={closeSketchCluster}
            title="Back to chat"
          >
            <ArrowLeft />
          </Button>
        ) : viewingQuestionThread ? (
          <Button
            variant="ghost"
            iconOnly
            onClick={closeQuestionThread}
            title="Back to chat"
          >
            <ArrowLeft />
          </Button>
        ) : (
          <Button
            variant="ghost"
            iconOnly
            onClick={handleNewChat}
            title="New conversation"
            disabled={isLoading}
          >
            <Plus />
          </Button>
        )
      }
    >
      <div className="flex h-full flex-col gap-2 overflow-visible">
        <MessageList
          messages={viewingSketchCluster ? sketchMessages : messages}
          isLoading={
            viewingSketchCluster ? false : isLoading || !isHistoryLoaded
          }
          hideAIActions={mode === 'operate' || !!viewingSketchCluster}
          onIntentReselect={handleIntentReselect}
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

        {/* Input is hidden in sketch inspector mode — it's a read-only view. */}
        {!viewingSketchCluster && (
          <ChatInput
            value={input}
            onChange={setInput}
            onSubmit={handleSubmit}
            onStop={stopStream}
            isStreaming={isLoading}
            mode={mode}
            slashCommands={slashCommands}
            onSlashMenuIntent={refreshSlashCommands}
            acpSelectorsSlot={
              agentBinding.kind === 'external' ? (
                <AcpSessionSelectors
                  meta={acpSessionMeta}
                  onSelectMode={handleAcpSelectMode}
                  onSelectModel={handleAcpSelectModel}
                  onSelectConfigOption={handleAcpSelectConfigOption}
                />
              ) : null
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
            disabled={isLoading || !isHistoryLoaded}
          />
        )}
      </div>
    </SidebarPanel>
  );
};
