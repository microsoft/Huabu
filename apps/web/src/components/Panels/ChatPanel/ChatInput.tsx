import { ArrowUp, FileText, Paperclip, Square, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { uploadImage, uploadPdf } from '@/api/artifact';
import { useChatStore } from '@/store/chatStore';

import { ContextUsageRing } from './ContextUsageRing';
import { ModeSelector } from './ModeSelector';
import { SourceCount } from './SelectedNodeRefs';
import { NODE_ICON } from '../../../config/nodeIcons';
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
  const addPendingAttachment = useChatStore((s) => s.addPendingAttachment);
  const removePendingAttachment = useChatStore(
    (s) => s.removePendingAttachment,
  );
  const [isDragOver, setIsDragOver] = useState(false);

  // Upload a file and add it as a pending attachment
  const attachFile = useCallback(
    async (file: File) => {
      try {
        if (file.type.startsWith('image/')) {
          const url = await uploadImage(file);
          addPendingAttachment({
            type: 'image',
            url,
            label: file.name || 'Image',
          });
        } else if (file.type === 'application/pdf') {
          const url = await uploadPdf(file);
          addPendingAttachment({
            type: 'pdf',
            url,
            label: file.name || 'PDF',
            filename: file.name,
          });
        } else {
          const url = await uploadImage(file);
          addPendingAttachment({
            type: 'file',
            url,
            label: file.name || 'File',
            filename: file.name,
          });
        }
      } catch (err) {
        console.error('Failed to upload file:', err);
      }
    },
    [addPendingAttachment],
  );

  // Handle paste — upload pasted images/files as attachments
  const handlePaste = useCallback(
    async (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of items) {
        if (item.kind !== 'file') continue;
        const file = item.getAsFile();
        if (!file) continue;
        e.preventDefault();
        await attachFile(file);
      }
    },
    [attachFile],
  );

  // Handle drag-and-drop
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const files = e.dataTransfer?.files;
      if (!files) return;
      for (const file of files) {
        await attachFile(file);
      }
    },
    [attachFile],
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
          if (historyIndexRef.current <= -1) return;
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
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <form onSubmit={handleSubmit} className="w-full">
        <div
          className={`rounded-2xl border p-3 transition-colors ${isDragOver ? 'border-border bg-theme-50' : 'border-border bg-white'}`}
        >
          {/* ── Pending attachment thumbnails ── */}
          {pendingAttachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {[...pendingAttachments]
                .sort((a, b) =>
                  a.originSourceId === '__selection__'
                    ? -1
                    : b.originSourceId === '__selection__'
                      ? 1
                      : 0,
                )
                .map((att) => {
                  const isSelection = att.originSourceId === '__selection__';
                  const idx = pendingAttachments.indexOf(att);
                  return (
                    <div
                      key={att.url || `sel-${idx}`}
                      className={`group relative flex items-center justify-center rounded-md ${isSelection ? 'border-border cursor-pointer border border-dashed' : 'border-border border'}`}
                      onClick={
                        isSelection
                          ? () => {
                              // Lock: convert selection attachment to a regular one
                              const locked = { ...att };
                              delete (locked as Record<string, unknown>)
                                .originSourceId;
                              useChatStore
                                .getState()
                                .setSelectionAttachment(null);
                              addPendingAttachment(locked);
                            }
                          : undefined
                      }
                    >
                      {att.type === 'image' ? (
                        <img
                          src={att.url}
                          alt={att.label ?? 'Attached image'}
                          className="h-14 w-14 rounded-md object-contain"
                        />
                      ) : (
                        <div className="flex h-14 w-14 flex-col items-center justify-center gap-0.5 rounded-md bg-gray-50 px-1">
                          {isSelection || att.type === 'file' ? (
                            <NODE_ICON.note
                              size={16}
                              className="text-gray-400"
                            />
                          ) : att.type === 'pdf' ? (
                            <FileText size={16} className="text-red-400" />
                          ) : (
                            <Paperclip size={16} className="text-gray-400" />
                          )}
                          <span className="w-full truncate text-center text-[8px] text-gray-500">
                            {att.filename ?? att.label ?? 'file'}
                          </span>
                        </div>
                      )}
                      <IconButton
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isSelection) {
                            useChatStore
                              .getState()
                              .setSelectionAttachment(null);
                          } else {
                            removePendingAttachment(idx);
                          }
                        }}
                        tooltipWrapperClassName="absolute top-0.5 right-0.5 inline-flex opacity-0 transition-opacity group-hover:opacity-100"
                        className="rounded-full bg-black/50 p-0.5 text-white enabled:hover:bg-black/70"
                        title="Remove attachment"
                      >
                        <X size={10} />
                      </IconButton>
                    </div>
                  );
                })}
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
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
              <ContextUsageRing draftText={value} isStreaming={isStreaming} />
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
