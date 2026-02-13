import { createId } from '@sediment/shared';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';

import { chatApi } from '@/api/chat';
import useCanvasStore from '@/store/canvasStore';

import { SidebarPanel } from '../SidebarPanel';
import { ChatInput } from './ChatInput';
import { MessageList } from '../../Messages/MessageList';

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

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
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
          disabled={isLoading}
        />
      </div>
    </SidebarPanel>
  );
};
