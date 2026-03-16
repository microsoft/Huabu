import {
  createId,
  type ResearchConfig,
  type IntentAction,
  type ToolResponse,
} from '@sediment/shared';
import { PanelRightClose, PanelRightOpen, Plus } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';

import { chatApi } from '@/api/chat';
import { resolveActions } from '@/api/intent';
import { researchApi } from '@/api/research';
import { GhostButton } from '@/components/Common/GhostButton';
import useCanvasStore, {
  type CanvasPreviewSnapshot,
} from '@/store/canvasStore';
import { useChatStore } from '@/store/chatStore';
import { useResearchStore } from '@/store/researchStore';
import { executeIntentActions } from '@/utils/intent/executor';
import { summarizeIntentActions } from '@/utils/intent/summary';

import { SidebarPanel } from '../SidebarPanel';
import { AgentChangeList } from './AgentChangeList';
import { ChatInput } from './ChatInput';
import { MessageList } from '../../Messages/MessageList';

import type { ChatMode } from './ModeSelector';
import type { ChatMessage } from '../../Messages/types';
import type { ChatStreamUpdatePayload } from '@sediment/shared';

interface AgentChangeSet {
  prompt: string;
  actions: IntentAction[];
  snapshot: CanvasPreviewSnapshot;
}

interface ChatPanelProps {
  isCollapsed?: boolean;
  onToggle?: () => void;
}

export const ChatPanel = ({ isCollapsed, onToggle }: ChatPanelProps) => {
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [agentChangeSet, setAgentChangeSet] = useState<AgentChangeSet | null>(
    null,
  );

  // Persistent chat state (survives page refresh)
  const threadId = useChatStore((state) => state.threadId);
  const messages = useChatStore((state) => state.messages);
  const isHistoryLoaded = useChatStore((state) => state.isHistoryLoaded);
  const addMessage = useChatStore((state) => state.addMessage);
  const updateMessage = useChatStore((state) => state.updateMessage);
  const setLastAction = useChatStore((state) => state.setLastAction);
  const clearMessages = useChatStore((state) => state.clearMessages);
  const pendingAttachments = useChatStore((state) => state.pendingAttachments);
  const clearPendingAttachments = useChatStore(
    (state) => state.clearPendingAttachments,
  );

  const getAgentContext = useCanvasStore((state) => state.getAgentContext);
  const getCanvasSnapshot = useCanvasStore((state) => state.getCanvasSnapshot);
  const restoreCanvasSnapshot = useCanvasStore(
    (state) => state.restoreCanvasSnapshot,
  );
  const canvasId = useCanvasStore((state) => state.canvasId);
  const canvasVersion = useCanvasStore((state) => state.version);
  const loadCanvas = useCanvasStore((state) => state.loadCanvas);

  // Research store (for current session UI state only, not persisted)
  const researchStatus = useResearchStore((state) => state.status);
  const startResearchState = useResearchStore((state) => state.startResearch);
  const handleEvent = useResearchStore((state) => state.handleEvent);
  const completeResearch = useResearchStore((state) => state.completeResearch);
  const setError = useResearchStore((state) => state.setError);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading]);

  // Load history from server on first mount (once per thread)
  useEffect(() => {
    // Read current value from store directly to avoid stale closure
    if (useChatStore.getState().isHistoryLoaded) return;

    // Guard against threadId changing while the async fetch is in flight.
    // If the effect is cleaned up (e.g. threadId changed or component unmounted)
    // before the fetch resolves, we discard the stale result.
    let cancelled = false;

    const {
      threadId: tid,
      lastAction: action,
      setMessages: set,
      setHistoryLoaded: setLoaded,
    } = useChatStore.getState();

    // Load checkpoint based on last action type
    // Both chat and research now return ChatHistoryResponse with messages[]
    const api = action === 'research' ? researchApi : chatApi;

    api
      .fetchHistory(tid)
      .then((res) => {
        if (cancelled) return;

        const serverMessages: ChatMessage[] = res.messages.map(
          (m, i): ChatMessage => {
            const id = `history-${i}`;

            // ChatHistoryItem is a union type
            // Check for tool message variant
            if ('toolResponse' in m) {
              return {
                id,
                role: 'tool',
                toolResponse: m.toolResponse as ToolResponse<string, unknown>,
              };
            }

            // Otherwise it's user/assistant message variant
            return {
              id,
              role: m.role,
              content: m.content || '',
              ...('attachments' in m &&
                m.attachments &&
                m.attachments.length > 0 && {
                  attachments: m.attachments,
                }),
            };
          },
        );
        // All messages come from backend checkpoint
        set(serverMessages);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Non-fatal: just start with an empty list
        console.warn(`Could not load ${action} history:`, err);
        setLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [threadId]);

  const handleDeepResearch = async () => {
    if (!input.trim() || isLoading || researchStatus === 'running') return;

    // Add user message
    const userMessage: ChatMessage = {
      id: createId('message'),
      role: 'user',
      content: input,
    };
    addMessage(userMessage);

    // Record last action for checkpoint restoration
    setLastAction('research');

    // Start research
    const query = input;
    setInput('');

    const config: ResearchConfig = {
      searchDepth: 'basic',
      placement: 'auto',
      groupWithFrame: true,
    };

    startResearchState(query, config);

    try {
      await researchApi.startResearch(
        query,
        canvasId,
        canvasVersion,
        threadId,
        config,
        {
          onEvent: (event) => {
            // Update research state
            handleEvent(event);

            // Add research steps as tool messages to chat
            if (event.data.toolResponse) {
              addMessage({
                id: createId('tool'),
                role: 'tool',
                toolResponse: event.data.toolResponse,
              });
            }
          },
          onError: (error: Error) => {
            console.error('Research error:', error);
            setError(error.message);
          },
          onComplete: () => {
            completeResearch();
            // Reload canvas after research completes
            loadCanvas();
          },
        },
      );
    } catch (err) {
      console.error('Research failed:', err);
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const handleChat = async () => {
    if (!input.trim() || isLoading) return;

    // Record last action for checkpoint restoration
    setLastAction('chat');

    // Snapshot and clear pending attachments before sending
    const attachments =
      pendingAttachments.length > 0 ? [...pendingAttachments] : undefined;
    if (attachments) clearPendingAttachments();

    const userMessage: ChatMessage = {
      id: createId('message'),
      role: 'user',
      content: input,
      attachments,
    };

    addMessage(userMessage);
    setInput('');
    setIsLoading(true);

    const assistantId = createId('message');

    await chatApi.streamMessage(
      userMessage.content,
      threadId,
      getAgentContext(),
      {
        onUpdate: (payload: ChatStreamUpdatePayload) => {
          const { node, message } = payload;

          // Handle Agent Updates (LLM Text)
          if (node === 'agent' && message) {
            if (message.content) {
              const existing = useChatStore
                .getState()
                .messages.find((m) => m.id === assistantId);
              if (existing) {
                // Append new token to existing content
                updateMessage(assistantId, (m) =>
                  m.role === 'user' || m.role === 'assistant'
                    ? { ...m, content: m.content + message.content }
                    : m,
                );
              } else {
                // First token - create new message
                addMessage({
                  id: assistantId,
                  role: 'assistant',
                  content: message.content,
                });
              }
            }

            // Handle Tool Updates
          } else if (node === 'tools') {
            const toolResponse = payload.toolResponse;
            if (!toolResponse) return;

            addMessage({
              id: createId('tool'),
              role: 'tool',
              toolResponse,
            });
          }
        },
        onError: (err) => {
          console.error(err);
          addMessage({
            id: createId('message'),
            role: 'assistant',
            content: 'Error: ' + err.message,
          });
        },
        onComplete: () => {
          setIsLoading(false);
        },
      },
      attachments,
    );
  };

  const handleAgent = async () => {
    if (!input.trim() || isLoading || agentChangeSet) return;

    const prompt = input.trim();

    // Agent-mode changes live in the local chat surface rather than a
    // dedicated backend checkpoint, so reuse chat history semantics.
    setLastAction('chat');

    const userMessage: ChatMessage = {
      id: createId('message'),
      role: 'user',
      content: prompt,
    };

    addMessage(userMessage);
    setInput('');
    setIsLoading(true);

    try {
      const { actions } = await resolveActions(getAgentContext(), prompt);

      if (actions.length === 0) {
        addMessage({
          id: createId('message'),
          role: 'assistant',
          content:
            'No actionable canvas changes were generated for that request.',
        });
        return;
      }

      const snapshot = getCanvasSnapshot();
      executeIntentActions(actions);
      setAgentChangeSet({ prompt, actions, snapshot });

      addMessage({
        id: createId('message'),
        role: 'assistant',
        content: summarizeIntentActions(actions),
      });
    } catch (err) {
      console.error('Agent action resolution failed:', err);
      addMessage({
        id: createId('message'),
        role: 'assistant',
        content:
          err instanceof Error
            ? `Agent error: ${err.message}`
            : 'Agent error: unknown error',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeepAgentChanges = () => {
    setAgentChangeSet(null);
  };

  const handleUpdateAgentAction = (index: number, updated: IntentAction) => {
    if (!agentChangeSet) return;

    const nextActions = [...agentChangeSet.actions];
    nextActions[index] = updated;

    restoreCanvasSnapshot(agentChangeSet.snapshot);
    executeIntentActions(nextActions);
    setAgentChangeSet({
      ...agentChangeSet,
      actions: nextActions,
    });
  };

  const handleRevertAgentChanges = () => {
    if (!agentChangeSet) return;

    restoreCanvasSnapshot(agentChangeSet.snapshot);
    setAgentChangeSet(null);
    addMessage({
      id: createId('message'),
      role: 'assistant',
      content: 'Reverted the proposed agent changes.',
    });
  };

  const handleSubmit = async (e: React.FormEvent, mode: ChatMode) => {
    e.preventDefault();

    if (mode === 'deep-research') {
      await handleDeepResearch();
    } else if (mode === 'agent') {
      await handleAgent();
    } else {
      await handleChat();
    }
  };

  const handleNewChat = () => {
    if (isLoading || researchStatus === 'running' || agentChangeSet) return;
    clearMessages();
  };

  return (
    <SidebarPanel
      title="Chat"
      isCollapsed={isCollapsed}
      onToggle={onToggle}
      iconCollapsed={<PanelRightOpen size={16} />}
      iconExpanded={<PanelRightClose size={16} />}
      className="border-border border-l"
      tools={
        <GhostButton
          onClick={handleNewChat}
          title="New conversation"
          disabled={
            isLoading || researchStatus === 'running' || !!agentChangeSet
          }
          className="text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus size={16} />
        </GhostButton>
      }
    >
      <div className="flex h-full flex-col gap-2 overflow-visible">
        <MessageList
          messages={messages}
          isLoading={isLoading || !isHistoryLoaded}
          endRef={messagesEndRef}
        />

        {agentChangeSet && (
          <AgentChangeList
            prompt={agentChangeSet.prompt}
            actions={agentChangeSet.actions}
            onUpdateAction={handleUpdateAgentAction}
            onKeep={handleKeepAgentChanges}
            onRevert={handleRevertAgentChanges}
          />
        )}

        {/* Input Area */}
        <ChatInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          disabled={
            isLoading ||
            !isHistoryLoaded ||
            researchStatus === 'running' ||
            !!agentChangeSet
          }
        />
      </div>
    </SidebarPanel>
  );
};
