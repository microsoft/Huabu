import { ArrowUp, Square, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { uploadImage, uploadPdf } from '@/api/artifact';
import { useChatStore } from '@/store/chatStore';

import { ContextUsageRing } from './ContextUsageRing';
import { ModeSelector } from './ModeSelector';
import { SourceCount } from './SelectedNodeRefs';
import { IconButton } from '../../Common/IconButton';
import { Tooltip } from '../../Common/Tooltip';
import { NodeRef } from '../../Messages/NodeRef';

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
  const selectionAttachment = useChatStore((s) => s.selectionAttachment);
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
            source: 'upload',
            url,
            label: file.name || 'Image',
          });
        } else if (file.type === 'application/pdf') {
          const url = await uploadPdf(file);
          addPendingAttachment({
            type: 'pdf',
            source: 'upload',
            url,
            label: file.name || 'PDF',
            filename: file.name,
          });
        } else {
          // Read text content for text-based files
          const isText =
            file.type.startsWith('text/') ||
            /\.(md|txt|csv|json|xml|yaml|yml|log)$/i.test(file.name);
          const textContent = isText ? await file.text() : undefined;

          const url = await uploadImage(file);
          addPendingAttachment({
            type: 'file',
            source: 'upload',
            url,
            content: textContent,
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
          className={`rounded-2xl border p-3 transition-colors ${isDragOver ? 'border-border bg-info-bg' : 'border-border bg-surface'}`}
        >
          {/* ── Pending attachment thumbnails ── */}
          {(pendingAttachments.length > 0 || selectionAttachment) && (
            <div className="mb-2 flex flex-wrap gap-2">
              {/* Selection attachment (from text highlight in expanded panel) */}
              {selectionAttachment &&
                (() => {
                  const att = selectionAttachment;
                  const sourceNodeId = att.originSourceId;
                  const previewText = att.content ?? att.label ?? 'text';

                  const tooltipParts: React.ReactNode[] = [];
                  if (sourceNodeId) {
                    tooltipParts.push(
                      <div key="src" className="flex items-center gap-1">
                        <span className="text-fg-subtle">Source:</span>
                        <span className="[&>div]:text-fg-on-emphasis [&>div]:border-white/30 [&>div:hover]:bg-white/10">
                          <NodeRef nodeId={sourceNodeId} />
                        </span>
                      </div>,
                    );
                  }
                  if (att.content) {
                    const maxLen = 240;
                    const truncated =
                      att.content.length > maxLen
                        ? att.content.slice(0, maxLen) + '…'
                        : att.content;
                    tooltipParts.push(
                      <div key="content" className="mt-1 max-w-[360px]">
                        <span className="text-fg-subtle">Content: </span>
                        <span className="break-words whitespace-pre-wrap">
                          {truncated}
                        </span>
                      </div>,
                    );
                  }

                  const tile = (
                    <div
                      key="selection-att"
                      className="group border-border relative flex cursor-pointer items-center justify-center rounded-md border border-dashed"
                      onClick={() => {
                        // Lock the selection: promote to a regular pending attachment
                        const locked = { ...att };
                        useChatStore.getState().setSelectionAttachment(null);
                        addPendingAttachment(locked);
                      }}
                    >
                      <div className="bg-surface flex h-12 w-12 items-center justify-center rounded-md px-1">
                        <span className="text-fg-subtle line-clamp-3 w-full text-center text-[8px] leading-tight">
                          {previewText}
                        </span>
                      </div>
                      <IconButton
                        onClick={(e) => {
                          e.stopPropagation();
                          useChatStore.getState().setSelectionAttachment(null);
                        }}
                        tooltipWrapperClassName="absolute top-0.5 right-0.5 inline-flex opacity-0 transition-opacity group-hover:opacity-100"
                        className="text-fg-on-emphasis rounded-full bg-black/50 p-0.5 enabled:hover:bg-black/70"
                        title="Remove attachment"
                      >
                        <X size={10} />
                      </IconButton>
                    </div>
                  );

                  if (tooltipParts.length > 0) {
                    return (
                      <Tooltip
                        key="selection-att"
                        content={
                          <div className="flex flex-col">{tooltipParts}</div>
                        }
                      >
                        {tile}
                      </Tooltip>
                    );
                  }
                  return tile;
                })()}

              {/* Regular pending attachments */}
              {pendingAttachments.map((att, idx) => {
                const sourceNodeId = att.originSourceId;

                // Text preview for the tile
                const previewText =
                  att.content ?? att.label ?? att.filename ?? 'file';

                // Build tooltip content: source + content
                const tooltipParts: React.ReactNode[] = [];
                if (sourceNodeId) {
                  tooltipParts.push(
                    <div key="src" className="flex items-center gap-1">
                      <span className="text-fg-subtle">Source:</span>
                      <span className="[&>div]:text-fg-on-emphasis [&>div]:border-white/30 [&>div:hover]:bg-white/10">
                        <NodeRef nodeId={sourceNodeId} />
                      </span>
                    </div>,
                  );
                }
                if (att.content) {
                  const maxLen = 240;
                  const truncated =
                    att.content.length > maxLen
                      ? att.content.slice(0, maxLen) + '…'
                      : att.content;
                  tooltipParts.push(
                    <div key="content" className="mt-1 max-w-[360px]">
                      <span className="text-fg-subtle">Content: </span>
                      <span className="break-words whitespace-pre-wrap">
                        {truncated}
                      </span>
                    </div>,
                  );
                } else if (att.filename || att.label) {
                  if (!sourceNodeId) {
                    tooltipParts.push(
                      <span key="label">{att.filename ?? att.label}</span>,
                    );
                  }
                }

                const tile = (
                  <div
                    key={att.url || `att-${idx}`}
                    className="group border-border relative flex items-center justify-center rounded-md border"
                  >
                    {att.type === 'image' ? (
                      <img
                        src={att.url}
                        alt={att.label ?? 'Attached image'}
                        className="h-12 w-12 rounded-md object-contain"
                      />
                    ) : (
                      <div className="bg-surface flex h-12 w-12 items-center justify-center rounded-md px-1">
                        <span className="text-fg-subtle line-clamp-3 w-full text-center text-[8px] leading-tight">
                          {previewText}
                        </span>
                      </div>
                    )}
                    <IconButton
                      onClick={(e) => {
                        e.stopPropagation();
                        removePendingAttachment(idx);
                      }}
                      tooltipWrapperClassName="absolute top-0.5 right-0.5 inline-flex opacity-0 transition-opacity group-hover:opacity-100"
                      className="text-fg-on-emphasis rounded-full bg-black/50 p-0.5 enabled:hover:bg-black/70"
                      title="Remove attachment"
                    >
                      <X size={10} />
                    </IconButton>
                  </div>
                );

                if (tooltipParts.length > 0) {
                  return (
                    <Tooltip
                      key={att.url || `att-${idx}`}
                      content={
                        <div className="flex flex-col">{tooltipParts}</div>
                      }
                    >
                      {tile}
                    </Tooltip>
                  );
                }
                return tile;
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
            className="text-fg-default placeholder:text-fg-subtle w-full resize-none bg-transparent text-sm focus:outline-none disabled:cursor-not-allowed"
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
