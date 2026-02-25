import { ArrowUp } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { ModeSelector, type ChatMode } from './ModeSelector';
import { IconButton } from '../../Common/IconButton';

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (e: React.FormEvent, mode: ChatMode) => void;
  disabled?: boolean;
  placeholder?: string;
}

export const ChatInput = ({
  value,
  onChange,
  onSubmit,
  disabled = false,
  placeholder = 'Asking anything here...',
}: ChatInputProps) => {
  const [mode, setMode] = useState<ChatMode>('chat');
  const isSubmitDisabled = disabled || !value.trim();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Dynamic placeholder based on mode
  const currentPlaceholder =
    mode === 'deep-research' ? 'Enter your research query...' : placeholder;

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = 'auto';

    const lineHeight = Number.parseFloat(
      window.getComputedStyle(textarea).lineHeight || '0',
    );
    const maxLines = 5;
    const maxHeight =
      Number.isFinite(lineHeight) && lineHeight > 0
        ? lineHeight * maxLines
        : textarea.scrollHeight;

    const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY =
      textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [value]);

  // Handle Enter key for submission
  const handleKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement> = (
    e,
  ) => {
    if (disabled) return;
    if (e.key !== 'Enter') return;
    if (e.shiftKey) return;
    if (e.nativeEvent.isComposing) return;
    if (isSubmitDisabled) return;

    e.preventDefault();
    onSubmit(e, mode);
  };

  // Handle form submission
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isSubmitDisabled) {
      onSubmit(e, mode);
    }
  };

  return (
    <div>
      <form onSubmit={handleSubmit} className="w-full">
        <div className="border-border rounded-2xl border bg-white p-3">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={currentPlaceholder}
            disabled={disabled}
            rows={2}
            className="w-full resize-none bg-transparent text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none disabled:cursor-not-allowed"
          />

          <div className="mt-2 flex items-center justify-between gap-3">
            <ModeSelector value={mode} onChange={setMode} disabled={disabled} />

            <IconButton
              type="submit"
              title="Send Message"
              disabled={isSubmitDisabled}
              aria-label="Send"
              size="sm"
              variant="solid"
            >
              <ArrowUp size={16} />
            </IconButton>
          </div>
        </div>
      </form>
    </div>
  );
};
