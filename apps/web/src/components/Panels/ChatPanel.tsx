import { PanelRightClose, PanelRightOpen, Send } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';

import { chatApi } from '../../api/chat';

import { SidebarPanel } from './SidebarPanel';

import type { ChatStreamUpdatePayload } from '@sediment/shared';

interface ChatPanelProps {
  isCollapsed?: boolean;
  onToggle?: () => void;
}

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export const ChatPanel = ({ isCollapsed, onToggle }: ChatPanelProps) => {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
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

    const userMessage: Message = {
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
          setMessages((prev) => [
            ...prev,
            {
              id: Date.now().toString(),
              role: 'system',
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
        {/* Messages List - Simple implementation, needs proper scrolling and styling */}
        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${
                msg.role === 'user' ? 'justify-end' : 'justify-start'
              }`}
            >
              <div
                className={`max-w-[80%] rounded-lg p-3 text-sm ${
                  msg.role === 'user'
                    ? 'bg-blue-500 text-white'
                    : msg.role === 'system'
                    ? 'border border-yellow-200 bg-yellow-50 font-mono text-xs text-yellow-800'
                    : 'bg-gray-100 text-gray-900'
                }`}
              >
                {msg.content}
              </div>
            </div>
          ))}
          {isLoading && (
            <div className="flex justify-start">
              <div className="animate-pulse rounded-lg bg-gray-100 p-3 text-sm text-gray-500">
                {loadingText}
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input Area */}
        <div className="border-t border-gray-200 p-4">
          <form onSubmit={handleSubmit} className="flex gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask me anything..."
              className="flex-1 rounded-md border border-gray-300 px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:outline-none"
              disabled={isLoading}
            />
            <button
              type="submit"
              disabled={isLoading || !input.trim()}
              className="rounded-md bg-blue-500 p-2 text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Send size={20} />
            </button>
          </form>
        </div>
      </div>
    </SidebarPanel>
  );
};
