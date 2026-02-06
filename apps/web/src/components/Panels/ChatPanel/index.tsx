import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';

import { chatApi } from '@/api/chat';

import { SidebarPanel } from '../SidebarPanel';
import { ChatInput } from './ChatInput';
import { MessageList } from './messages/MessageList';

import type { ChatMessage } from './messages/types';
import type {
  ChatStreamUpdatePayload,
  WebSearchToolResponse,
} from '@sediment/shared';

function parseWebSearchToolResponse(
  content: string,
): WebSearchToolResponse | null {
  try {
    const data = JSON.parse(content) as unknown;
    if (typeof data !== 'object' || data === null) return null;
    if ((data as { tool?: unknown }).tool !== 'web_search') return null;

    return data as WebSearchToolResponse;
  } catch {
    return null;
  }
}

function toMarkdownSources(
  sources: Array<{ title: string; url: string }>,
): string {
  const lines = sources.map((s) => {
    const safeTitle = s.title.replace(/\n/g, ' ').replace(/\]/g, '\\]');
    return `- [${safeTitle}](${s.url})`;
  });

  return ['Sources:', ...lines].join('\n');
}

interface ChatPanelProps {
  isCollapsed?: boolean;
  onToggle?: () => void;
}

export const ChatPanel = ({ isCollapsed, onToggle }: ChatPanelProps) => {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);

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
      id: Date.now().toString(),
      role: 'user',
      content: input,
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    const assistantId = (Date.now() + 1).toString();

    await chatApi.streamMessage(userMessage.content, {
      onUpdate: (payload: ChatStreamUpdatePayload) => {
        const { node, message } = payload;

        // Handle Agent Updates (LLM Text)
        if (node === 'agent' && message) {
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
          }

          // Handle Tool Updates
        } else if (node === 'tools' && message) {
          const parsed = message.content
            ? parseWebSearchToolResponse(message.content)
            : null;

          if (parsed && parsed.status === 'success') {
            const results = parsed.data.results;
            const sources = results;

            setMessages((prev) => [
              ...prev,
              {
                id: Date.now().toString(),
                role: 'assistant',
                content:
                  sources.length > 0
                    ? toMarkdownSources(sources)
                    : 'Sources: (none)',
              },
            ]);
          } else if (parsed && parsed.status === 'error') {
            setMessages((prev) => [
              ...prev,
              {
                id: Date.now().toString(),
                role: 'assistant',
                content: `Web search error: ${parsed.error}`,
              },
            ]);
          }
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
      iconCollapsed={<PanelRightOpen />}
      iconExpanded={<PanelRightClose />}
      className="border-border border-l"
    >
      <div className="flex h-full flex-col overflow-hidden">
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
