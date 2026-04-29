import { ArrowLeft, PanelRightClose, PanelRightOpen, Plus } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';

import { Button } from '@/components/Common/Button';
import useCanvasStore from '@/store/canvasStore';
import { useChatStore } from '@/store/chatStore';
import { useIntentStore } from '@/store/intentStore';

import { SidebarPanel } from '../SidebarPanel';
import { ChatInput } from './ChatInput';
import { useAnnotationClusterMessages } from './useAnnotationClusterMessages';
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

  // Question thread replay mode
  const viewingQuestionThread = useChatStore((s) => s.viewingQuestionThread);
  const closeQuestionThread = useChatStore((s) => s.closeQuestionThread);

  // Annotation cluster inspector mode (mutually exclusive with question
  // replay). When set, MessageList renders synthesized messages built from
  // the live cluster state instead of the canvas chat.
  const viewingAnnotationCluster = useChatStore(
    (s) => s.viewingAnnotationCluster,
  );
  const closeAnnotationCluster = useChatStore((s) => s.closeAnnotationCluster);
  const annotationMessages = useAnnotationClusterMessages(
    viewingAnnotationCluster?.clusterId ?? null,
  );

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
      // Return the promise so callers (e.g. annotation recognition) can
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
      title={
        viewingAnnotationCluster
          ? 'Annotation Recognition'
          : viewingQuestionThread
            ? 'Question Replay'
            : 'Chat'
      }
      isCollapsed={isCollapsed}
      onToggle={onToggle}
      iconCollapsed={<PanelRightOpen size={16} />}
      iconExpanded={<PanelRightClose size={16} />}
      className="border-edge-default border-l"
      tools={
        viewingAnnotationCluster ? (
          <Button
            variant="ghost"
            iconOnly
            onClick={closeAnnotationCluster}
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
          messages={viewingAnnotationCluster ? annotationMessages : messages}
          isLoading={
            viewingAnnotationCluster ? false : isLoading || !isHistoryLoaded
          }
          hideAIActions={mode === 'operate' || !!viewingAnnotationCluster}
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

        {/* Input is hidden in annotation inspector mode — it's a read-only view. */}
        {!viewingAnnotationCluster && (
          <ChatInput
            value={input}
            onChange={setInput}
            onSubmit={handleSubmit}
            onStop={stopStream}
            isStreaming={isLoading}
            mode={mode}
            onModeChange={setMode}
            disabled={isLoading || !isHistoryLoaded}
          />
        )}
      </div>
    </SidebarPanel>
  );
};
