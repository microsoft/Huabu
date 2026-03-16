import {
  createId,
  type ChatAttachment,
  type ResearchConfig,
  type ToolResponse,
} from '@sediment/shared';
import { PanelRightClose, PanelRightOpen, Plus } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';

import { researchApi } from '@/api/research';
import { agentApi } from '@/api/unified-agent';
import { IconButton } from '@/components/Common/IconButton';
import useCanvasStore from '@/store/canvasStore';
import { useChatStore } from '@/store/chatStore';
import { useIntentStore } from '@/store/intentStore';
import { useResearchStore } from '@/store/researchStore';

import { SidebarPanel } from '../SidebarPanel';
import { ChatInput } from './ChatInput';
import { MessageList } from '../../Messages/MessageList';

import type { ChatMode } from './ModeSelector';
import type { ChatMessage } from '../../Messages/types';
import type { AgentStreamEvent } from '@sediment/shared';

/**
 * Parse a tool result string into a proper ToolResponse.
 */
function parseToolResponse(
  toolName: string,
  raw: string | undefined,
): ToolResponse<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      'tool' in parsed &&
      'status' in parsed
    ) {
      return parsed as ToolResponse<string, unknown>;
    }
    return { tool: toolName, status: 'success', data: parsed };
  } catch {
    return { tool: toolName, status: 'success', data: { content: raw } };
  }
}

interface ChatPanelProps {
  isCollapsed?: boolean;
  onToggle?: () => void;
}

export const ChatPanel = ({ isCollapsed, onToggle }: ChatPanelProps) => {
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);

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
  const canvasId = useCanvasStore((state) => state.canvasId);
  const canvasVersion = useCanvasStore((state) => state.version);
  const loadCanvas = useCanvasStore((state) => state.loadCanvas);
  const refreshCanvas = useCanvasStore((state) => state.refreshCanvas);

  // Research store (for current session UI state only, not persisted)
  const researchStatus = useResearchStore((state) => state.status);
  const startResearchState = useResearchStore((state) => state.startResearch);
  const completeResearch = useResearchStore((state) => state.completeResearch);
  const setError = useResearchStore((state) => state.setError);

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

    // Load checkpoint — both ask and research use the unified agent API
    agentApi
      .fetchHistory(tid)
      .then((res) => {
        if (cancelled) return;

        const serverMessages: ChatMessage[] = res.messages.map(
          (m, i): ChatMessage => {
            const id = `history-${i}`;

            // Tool message — has toolResponse object
            if (m.role === 'tool') {
              return {
                id,
                role: 'tool' as const,
                toolResponse: m.toolResponse as ToolResponse<string, unknown>,
              };
            }

            // User/assistant message
            const msg = m as {
              role: 'user' | 'assistant';
              content: string;
              attachments?: ChatAttachment[];
            };
            return {
              id,
              role: msg.role,
              content: msg.content || '',
              ...(msg.attachments &&
                msg.attachments.length > 0 && {
                  attachments: msg.attachments,
                }),
            };
          },
        );
        set(serverMessages);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.warn(`Could not load ${action} history:`, err);
        setLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [threadId]);

  const handleDeepResearch = async () => {
    if (!input.trim() || isLoading || researchStatus === 'running') return;

    // Snapshot and clear pending attachments before sending
    const attachments =
      pendingAttachments.length > 0 ? [...pendingAttachments] : undefined;
    if (attachments) clearPendingAttachments();

    // Add user message
    const userMessage: ChatMessage = {
      id: createId('message'),
      role: 'user',
      content: input,
      attachments,
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

    const researchAssistantId = createId('message');

    try {
      await researchApi.startResearch(
        query,
        canvasId,
        canvasVersion,
        threadId,
        config,
        {
          onEvent: (event) => {
            // Stream text deltas to the chat as assistant message
            if (event.type === 'text_delta') {
              const delta = (event.data as { content?: string }).content ?? '';
              const existing = useChatStore
                .getState()
                .messages.find((m) => m.id === researchAssistantId);
              if (existing) {
                updateMessage(researchAssistantId, (m) =>
                  m.role === 'user' || m.role === 'assistant'
                    ? { ...m, content: m.content + delta }
                    : m,
                );
              } else {
                addMessage({
                  id: researchAssistantId,
                  role: 'assistant',
                  content: delta,
                });
              }
            }

            // Add tool results as tool messages to chat
            if (event.type === 'tool_result') {
              const toolName =
                (event.data as { toolName?: string }).toolName ?? 'unknown';
              const raw = (event.data as { toolResult?: string }).toolResult;
              const toolResponse = parseToolResponse(toolName, raw);
              if (toolResponse) {
                addMessage({
                  id: createId('tool'),
                  role: 'tool',
                  toolResponse,
                });
              }
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
        {
          canvasContext: getAgentContext(),
          attachments,
        },
      );
    } catch (err) {
      console.error('Research failed:', err);
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const handleStreamingChat = useCallback(
    async (prompt: string, mode: 'ask' | 'agent') => {
      if (!prompt.trim() || isLoading) return;

      setLastAction('ask');

      // Snapshot and clear pending attachments before sending
      const attachments =
        pendingAttachments.length > 0 ? [...pendingAttachments] : undefined;
      if (attachments) clearPendingAttachments();

      const userMessage: ChatMessage = {
        id: createId('message'),
        role: 'user',
        content: prompt,
        attachments,
      };

      addMessage(userMessage);
      setIsLoading(true);

      const assistantId = createId('message');

      try {
        await agentApi.streamMessage(
          prompt,
          threadId,
          mode,
          {
            onEvent: (event: AgentStreamEvent) => {
              if (event.type === 'text_delta') {
                const delta = event.data.content ?? '';
                const existing = useChatStore
                  .getState()
                  .messages.find((m) => m.id === assistantId);
                if (existing) {
                  updateMessage(assistantId, (m) =>
                    m.role === 'user' || m.role === 'assistant'
                      ? { ...m, content: m.content + delta }
                      : m,
                  );
                } else {
                  addMessage({
                    id: assistantId,
                    role: 'assistant',
                    content: delta,
                  });
                }
              } else if (event.type === 'tool_result') {
                const toolResponse = parseToolResponse(
                  event.data.toolName ?? 'unknown',
                  event.data.toolResult,
                );
                if (toolResponse) {
                  addMessage({
                    id: createId('tool'),
                    role: 'tool',
                    toolResponse,
                  });
                }
                // Silently refresh canvas data after each tool result in agent mode
                // so the canvas reflects changes without disturbing the chat panel.
                if (mode === 'agent') {
                  void refreshCanvas();
                }
              }
            },
            onError: (err) => {
              console.error(`${mode} error:`, err);
              addMessage({
                id: createId('message'),
                role: 'assistant',
                content: `Error: ${err.message}`,
              });
            },
            onComplete: () => {
              setIsLoading(false);
              // Final refresh to ensure canvas is fully up to date
              if (mode === 'agent') {
                void refreshCanvas();
              }
            },
          },
          {
            canvasContext: getAgentContext(),
            canvasId: mode === 'agent' ? canvasId : undefined,
            attachments,
          },
        );
      } catch (err) {
        console.error(`${mode} failed:`, err);
        addMessage({
          id: createId('message'),
          role: 'assistant',
          content:
            err instanceof Error
              ? `Error: ${err.message}`
              : 'Error: unknown error',
        });
        setIsLoading(false);
      }
    },
    [
      isLoading,
      pendingAttachments,
      clearPendingAttachments,
      addMessage,
      setLastAction,
      threadId,
      updateMessage,
      refreshCanvas,
      getAgentContext,
      canvasId,
    ],
  );

  // Register intent callback — when user selects an intent in the popover,
  // it's sent here and executed as an agent chat message.
  // Also expand the chat panel if it's collapsed.
  useEffect(() => {
    const handleIntentChosen = (intent: string) => {
      // Open the chat panel if collapsed
      if (isCollapsed && onToggle) {
        onToggle();
      }
      // Send as agent mode message
      void handleStreamingChat(intent, 'agent');
    };
    useIntentStore.getState()._setOnIntentChosen(handleIntentChosen);
    return () => {
      useIntentStore.getState()._setOnIntentChosen(null);
    };
  }, [handleStreamingChat, isCollapsed, onToggle]);

  const handleSubmit = async (e: React.FormEvent, mode: ChatMode) => {
    e.preventDefault();

    if (mode === 'research') {
      await handleDeepResearch();
    } else {
      const prompt = input.trim();
      setInput('');
      await handleStreamingChat(prompt, mode);
    }
  };

  const handleNewChat = () => {
    if (isLoading || researchStatus === 'running') return;
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
        <IconButton
          onClick={handleNewChat}
          title="New conversation"
          disabled={isLoading || researchStatus === 'running'}
          className="text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus size={16} />
        </IconButton>
      }
    >
      <div className="flex h-full flex-col gap-2 overflow-visible">
        <MessageList
          messages={messages}
          isLoading={isLoading || !isHistoryLoaded}
        />

        {/* Input Area */}
        <ChatInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          disabled={
            isLoading || !isHistoryLoaded || researchStatus === 'running'
          }
        />
      </div>
    </SidebarPanel>
  );
};
