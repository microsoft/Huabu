import {
  ArrowLeft,
  ListIndentIncrease,
  PanelRightOpen,
  Plus,
} from 'lucide-react';
import { useState, useEffect, useCallback, useMemo } from 'react';

import { Button } from '@/components/Common/Button';
import { useAcpAgents } from '@/hooks/useAcpAgents';
import { useAcpSlashCommands } from '@/hooks/useAcpSlashCommands';
import useCanvasStore from '@/store/canvasStore';
import { useChatStore } from '@/store/chatStore';
import { useIntentStore } from '@/store/intentStore';
import { useLLMStore } from '@/store/llmStore';

import { SidebarPanel } from '../SidebarPanel';
import { ChatInput } from './ChatInput';
import { useSketchClusterMessages } from './useSketchClusterMessages';
import { useAgentStream } from '../../../hooks/useAgentStream';
import { useChatHistory } from '../../../hooks/useChatHistory';
import { MessageList } from '../../Messages/MessageList';

import type { AgentMode, IntentCandidate } from '@sediment/shared';

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
  } = useAcpAgents();

  // Slash commands for the currently-bound external agent. Empty array
  // when the thread is internal or the agent has nothing to offer.
  // `refreshIfStale` is plumbed into ChatInput so the typeahead can
  // lazily resync the list on the rising edge of "user wants the
  // slash menu" — covers the case where the agent pushes new
  // commands mid-session (e.g. after auth completes).
  const { commands: slashCommands, refreshIfStale: refreshSlashCommands } =
    useAcpSlashCommands({
      threadId,
      binding: agentBinding,
      canvasId,
    });

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
    const prompt = input.trim();
    setInput('');
    await startStream(prompt, agentMode);
  };

  const handleNewChat = () => {
    if (isLoading) return;
    clearMessages(canvasId || undefined);
  };

  return (
    <SidebarPanel
      title={panelTitle}
      tabs={
        <span className="block min-w-0 flex-1 truncate" title={panelTitle}>
          {panelTitle}
        </span>
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
            onModeChange={setMode}
            binding={agentBinding}
            onBindingChange={(b) => setAgentBinding(b, canvasId || undefined)}
            connectedAgents={connectedAgents}
            onRefreshAgents={refreshAcpAgents}
            refreshingAgents={acpAgentsLoading}
            onNewThread={handleNewChat}
            slashCommands={slashCommands}
            onSlashMenuIntent={refreshSlashCommands}
            // 1 thread = 1 binding. Lock the picker the moment a thread
            // has any message OR a stream is in flight — the user must
            // start a new chat to pick a different agent.
            bindingLocked={messages.length > 0 || isLoading}
            disabled={isLoading || !isHistoryLoaded}
          />
        )}
      </div>
    </SidebarPanel>
  );
};
