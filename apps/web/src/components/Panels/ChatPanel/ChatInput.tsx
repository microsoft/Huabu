import { ArrowUp, Plus } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { IconButton } from '../../Common/IconButton';
// import { PillButton } from '../../Common/PillButton';

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (e: React.FormEvent) => void;
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
  const isSubmitDisabled = disabled || !value.trim();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

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
    onSubmit(e);
  };

  return (
    <div>
      <form onSubmit={onSubmit} className="w-full">
        <div className="border-border rounded-2xl border bg-white p-3">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={disabled}
            rows={2}
            className="w-full resize-none bg-transparent text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none disabled:cursor-not-allowed"
          />

          <div className="mt-2 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <IconButton
                aria-label="Add"
                disabled={disabled}
                size="sm"
                variant="outline"
              >
                <Plus size={16} />
              </IconButton>

              {/* <PillButton disabled={disabled}>
                <Lightbulb size={16} />
                Think
              </PillButton>

              <PillButton disabled={disabled}>
                <Search size={16} />
                Deep Research
              </PillButton> */}
            </div>

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
