import { ArrowUp, Square, X } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { useChatStore } from '@/store/chatStore';

import { ContextUsageRing } from './ContextUsageRing';
import { ModeSelector } from './ModeSelector';
import { SourceCount } from './SelectedNodeRefs';
import { IconButton } from '../../Common/IconButton';

import type { AgentMode } from '@sediment/shared';

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (e: React.FormEvent, mode: AgentMode) => void;
  onStop: () => void;
  isStreaming?: boolean;
  mode: AgentMode;
  onModeChange: (mode: AgentMode) => void;
  disabled?: boolean;
  placeholder?: string;
}

export const ChatInput = ({
  value,
  onChange,
  onSubmit,
  onStop,
  isStreaming = false,
  mode,
  onModeChange,
  disabled = false,
  placeholder = 'Asking anything here...',
}: ChatInputProps) => {
  const isSubmitDisabled = disabled || !value.trim();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const historyIndexRef = useRef(-1);
  const draftRef = useRef('');

  // Pending attachments from the store
  const pendingAttachments = useChatStore((s) => s.pendingAttachments);
  const removePendingAttachment = useChatStore(
    (s) => s.removePendingAttachment,
  );

  // Dynamic placeholder based on mode
  const currentPlaceholder =
    mode === 'research'
      ? 'Enter your research query...'
      : mode === 'operate'
        ? 'Describe the canvas change you want...'
        : placeholder;

  // Auto-resize textarea
  useEffect(() => {
    if (mode === 'operate') return;

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
  }, [mode, value]);

  // Handle Enter key for submission and ArrowUp/ArrowDown for prompt history
  const handleKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement> = (
    e,
  ) => {
    if (disabled) return;
    if (e.nativeEvent.isComposing) return;

    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const ta = textareaRef.current;
      if (!ta) return;
      const atStart = ta.selectionStart === 0 && ta.selectionEnd === 0;
      const atEnd = ta.selectionStart === ta.value.length;
      if (
        (e.key === 'ArrowUp' && atStart) ||
        (e.key === 'ArrowDown' && atEnd)
      ) {
        const history = useChatStore
          .getState()
          .messages.filter((m) => m.role === 'user')
          .map((m) => (m.role === 'user' ? m.content : ''));
        if (history.length === 0) return;

        e.preventDefault();
        if (e.key === 'ArrowUp') {
          if (historyIndexRef.current === -1) draftRef.current = value;
          const next = Math.min(
            historyIndexRef.current + 1,
            history.length - 1,
          );
          historyIndexRef.current = next;
          onChange(history[history.length - 1 - next]);
          requestAnimationFrame(() => {
            ta.selectionStart = 0;
            ta.selectionEnd = 0;
          });
        } else {
          const next = historyIndexRef.current - 1;
          historyIndexRef.current = next;
          onChange(
            next < 0 ? draftRef.current : history[history.length - 1 - next],
          );
        }
        return;
      }
    }

    if (e.key !== 'Enter') return;
    if (e.shiftKey) return;
    if (isSubmitDisabled) return;

    e.preventDefault();
    historyIndexRef.current = -1;
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
          {/* ── Pending attachment thumbnails ── */}
          {pendingAttachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {pendingAttachments.map((att, i) => (
                <div
                  key={att.url}
                  className="border-border group relative flex items-center justify-center rounded-md border"
                >
                  <img
                    src={att.url}
                    alt={att.label ?? 'Attached image'}
                    className="h-14 w-14 rounded-md object-contain"
                  />
                  <IconButton
                    onClick={() => removePendingAttachment(i)}
                    tooltipWrapperClassName="absolute top-0.5 right-0.5 inline-flex opacity-0 transition-opacity group-hover:opacity-100"
                    className="rounded-full bg-black/50 p-0.5 text-white enabled:hover:bg-black/70"
                    title="Remove attachment"
                  >
                    <X size={10} />
                  </IconButton>
                </div>
              ))}
            </div>
          )}

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
            <div className="flex items-center gap-2">
              <ModeSelector
                value={mode}
                onChange={onModeChange}
                disabled={disabled}
              />
              <ContextUsageRing />
            </div>

            <div className="flex items-center gap-2">
              <SourceCount />

              {isStreaming ? (
                <IconButton
                  type="button"
                  title="Stop generating"
                  onClick={onStop}
                  aria-label="Stop"
                  size="sm"
                  variant="solid"
                >
                  <Square size={12} />
                </IconButton>
              ) : (
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
              )}
            </div>
          </div>
        </div>
      </form>
    </div>
  );
};
