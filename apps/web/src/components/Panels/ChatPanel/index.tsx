import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';

import { chatApi } from '@/api/chat';

import { SidebarPanel } from '../SidebarPanel';
import { ChatInput } from './ChatInput';
import { MessageList } from './messages/MessageList';

import type { ChatMessage } from './messages/types';
import type { ChatStreamUpdatePayload } from '@sediment/shared';

interface ChatPanelProps {
  isCollapsed?: boolean;
  onToggle?: () => void;
}

export const ChatPanel = ({ isCollapsed, onToggle }: ChatPanelProps) => {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingText, setLoadingText] = useState('Thinking...');

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading, loadingText]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: input,
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);
    setLoadingText('Thinking...');

    const assistantId = (Date.now() + 1).toString();

    await chatApi.streamMessage(userMessage.content, {
      onUpdate: (payload: ChatStreamUpdatePayload) => {
        const { node, message } = payload;

        // Handle Agent Updates (LLM Text)
        if (node === 'agent' && message) {
          // If the message has toolCalls, show status
          if (message.toolCalls && message.toolCalls.length > 0) {
            setLoadingText(`Calling tool: ${message.toolCalls[0].name}...`);
            return;
          }

          // Otherwise update conversation content
          if (message.content) {
            setMessages((prev) => {
              const existing = prev.find((m) => m.id === assistantId);
              if (existing) {
                return prev.map((m) =>
                  m.id === assistantId ? { ...m, content: message.content } : m,
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
            setLoadingText('Thinking...');
          }

          // Handle Tool Updates
        } else if (node === 'tools' && message) {
          // Usually message.content from a ToolNode is the JSON result
          // TODO:
          setMessages((prev) => [
            ...prev,
            {
              id: Date.now().toString(),
              role: 'assistant',
              content: `Tool Output: ${message.content.substring(0, 150)}...`,
            },
          ]);
        }
      },
      onError: (err) => {
        console.error(err);
        setMessages((prev) => [
          ...prev,
          {
            id: Date.now().toString(),
            role: 'assistant',
            content: 'Error: ' + err.message,
          },
        ]);
      },
      onComplete: () => {
        setIsLoading(false);
      },
    });
  };

  return (
    <SidebarPanel
      title="Chat"
      isCollapsed={isCollapsed}
      onToggle={onToggle}
      iconCollapsed={<PanelRightOpen size={20} />}
      iconExpanded={<PanelRightClose size={20} />}
    >
      <div className="flex h-full flex-col overflow-hidden">
        <MessageList
          messages={messages}
          isLoading={isLoading}
          loadingText={loadingText}
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
