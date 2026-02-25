import { createId, type ResearchConfig } from '@sediment/shared';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';

import { chatApi } from '@/api/chat';
import { researchApi } from '@/api/research';
import useCanvasStore from '@/store/canvasStore';
import { useResearchStore } from '@/store/researchStore';

import { SidebarPanel } from '../SidebarPanel';
import { ChatInput } from './ChatInput';
import { MessageList } from '../../Messages/MessageList';

import type { ChatMode } from './ModeSelector';
import type { ChatMessage } from '../../Messages/types';
import type { ChatStreamUpdatePayload } from '@sediment/shared';

interface ChatPanelProps {
  isCollapsed?: boolean;
  onToggle?: () => void;
}

export const ChatPanel = ({ isCollapsed, onToggle }: ChatPanelProps) => {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const threadIdRef = useRef<string>(createId('thread'));

  const getSelectedSourceIds = useCanvasStore(
    (state) => state.getSelectedSourceIds,
  );
  const canvasId = useCanvasStore((state) => state.canvasId);
  const canvasVersion = useCanvasStore((state) => state.version);
  const loadCanvas = useCanvasStore((state) => state.loadCanvas);

  // Research store
  const researchStatus = useResearchStore((state) => state.status);
  const researchQuery = useResearchStore((state) => state.query);
  const researchSteps = useResearchStore((state) => state.steps);
  const researchNodeIds = useResearchStore((state) => state.createdNodeIds);
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

  // Sync research state to messages
  useEffect(() => {
    if (researchStatus !== 'idle' && researchQuery) {
      // Find existing research message or create new one
      const researchMessageId = 'research-' + researchQuery;

      setMessages((prev) => {
        const hasResearchMessage = prev.some(
          (m) => m.role === 'research' && m.id === researchMessageId,
        );

        if (!hasResearchMessage) {
          // Add research message
          return [
            ...prev,
            {
              id: researchMessageId,
              role: 'research',
              query: researchQuery,
              steps: researchSteps,
              status: researchStatus,
              nodeIds: researchNodeIds,
            },
          ];
        } else {
          // Update existing research message
          return prev.map((m) =>
            m.role === 'research' && m.id === researchMessageId
              ? {
                  ...m,
                  steps: researchSteps,
                  status: researchStatus,
                  nodeIds: researchNodeIds,
                }
              : m,
          );
        }
      });
    }
  }, [researchStatus, researchQuery, researchSteps, researchNodeIds]);

  const handleDeepResearch = async () => {
    if (!input.trim() || isLoading || researchStatus === 'running') return;

    // Add user message
    const userMessage: ChatMessage = {
      id: createId('message'),
      role: 'user',
      content: input,
    };
    setMessages((prev) => [...prev, userMessage]);

    // Start research
    const query = input;
    setInput('');

    const config: ResearchConfig = {
      searchDepth: 'advanced',
      placement: 'auto',
      groupWithFrame: true,
    };

    startResearchState(query, config);

    try {
      await researchApi.startResearch(query, canvasId, canvasVersion, config, {
        onEvent: handleEvent,
        onError: (error: Error) => {
          console.error('Research error:', error);
          setError(error.message);
        },
        onComplete: () => {
          completeResearch();
          // Reload canvas after research completes
          loadCanvas();
        },
      });
    } catch (err) {
      console.error('Research failed:', err);
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const handleChat = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage: ChatMessage = {
      id: createId('message'),
      role: 'user',
      content: input,
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    const assistantId = createId('message');
    const selectedSourceIds = getSelectedSourceIds();

    await chatApi.streamMessage(
      userMessage.content,
      threadIdRef.current,
      selectedSourceIds,
      {
        onUpdate: (payload: ChatStreamUpdatePayload) => {
          const { node, message } = payload;

          // Handle Agent Updates (LLM Text)
          if (node === 'agent' && message) {
            if (message.content) {
              setMessages((prev) => {
                const existing = prev.find((m) => m.id === assistantId);
                if (existing) {
                  return prev.map((m) =>
                    m.id === assistantId
                      ? { ...m, content: message.content }
                      : m,
                  );
                } else {
                  return [
                    ...prev,
                    {
                      id: assistantId,
                      role: 'assistant',
                      content: message.content,
                    },
                  ];
                }
              });
            }

            // Handle Tool Updates
          } else if (node === 'tools') {
            const toolResponse = payload.toolResponse;
            if (!toolResponse) return;

            setMessages((prev) => [
              ...prev,
              {
                id: createId('tool'),
                role: 'tool',
                toolResponse,
              },
            ]);
          }
        },
        onError: (err) => {
          console.error(err);
          setMessages((prev) => [
            ...prev,
            {
              id: createId('message'),
              role: 'assistant',
              content: 'Error: ' + err.message,
            },
          ]);
        },
        onComplete: () => {
          setIsLoading(false);
        },
      },
    );
  };

  const handleSubmit = async (e: React.FormEvent, mode: ChatMode) => {
    e.preventDefault();

    if (mode === 'deep-research') {
      await handleDeepResearch();
    } else {
      await handleChat();
    }
  };

  return (
    <SidebarPanel
      title="Chat"
      isCollapsed={isCollapsed}
      onToggle={onToggle}
      iconCollapsed={<PanelRightOpen size={16} />}
      iconExpanded={<PanelRightClose size={16} />}
      className="border-border border-l"
    >
      <div className="flex h-full flex-col gap-2 overflow-visible">
        <MessageList
          messages={messages}
          isLoading={isLoading}
          endRef={messagesEndRef}
        />

        {/* Input Area */}
        <ChatInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          disabled={isLoading || researchStatus === 'running'}
        />
      </div>
    </SidebarPanel>
  );
};
