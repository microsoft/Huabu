import { ArrowUp, Square, X } from 'lucide-react';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';

import { uploadImage, uploadPdf } from '@/api/artifact';
import useCanvasStore from '@/store/canvasStore';
import { useChatStore } from '@/store/chatStore';

import { ContextUsageRing } from './ContextUsageRing';
import { SourceCount } from './SelectedNodeRefs';
import { SlashCommandMenu } from './SlashCommandMenu';
import { useSlashCommandTypeahead } from './useSlashCommandTypeahead';
import { Button } from '../../Common/Button';
import { NodeRef } from '../../Common/NodeRef';
import { Tooltip } from '../../Common/Tooltip';

import type { AgentMode, AvailableCommand } from '@sediment/shared';

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (e: React.FormEvent, mode: AgentMode) => void;
  onStop: () => void;
  isStreaming?: boolean;
  /** Current built-in mode. Affects placeholder + the value submitted to `onSubmit`. */
  mode: AgentMode;
  /**
   * Slash commands the bound external agent advertised via
   * `available_commands_update`. Empty when the binding is internal,
   * the agent has not pushed yet, or the agent simply exposes no
   * slash commands. The typeahead popover is suppressed in those
   * cases so the user doesn't see an empty menu.
   */
  slashCommands?: AvailableCommand[];
  /**
   * Called on the rising edge of "user wants the slash menu" — i.e.
   * the textarea transitions from "doesn't look like a slash" to
   * "starts with `/<letter>` and caret sits in that token". The
   * receiver (`useAcpSlashCommands.refreshIfStale`) decides whether
   * a fetch is actually due via its own TTL gate, so this can be
   * fired liberally.
   *
   * Fires regardless of whether `slashCommands` is currently empty
   * so an empty list caused by a missed push can recover the moment
   * the user signals intent.
   */
  onSlashMenuIntent?: () => void;
  /**
   * Optional slot rendered at the left of the toolbar (before the
   * `ContextUsageRing`). Used by ChatPanel to mount the ACP session
   * selectors (mode / model / config options) when the bound agent
   * advertises any. Hidden by simply passing nothing.
   */
  acpSelectorsSlot?: React.ReactNode;
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
  slashCommands = [],
  onSlashMenuIntent,
  acpSelectorsSlot,
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
  const canvasId = useCanvasStore((s) => s.canvasId);

  // ── Slash-command typeahead ──────────────────────────────────────
  //
  // All slash-related state (caret tracking, Esc-dismiss, activation
  // parsing, keyboard handling, command insertion) lives in the
  // hook. ChatInput only forwards events to it and renders the menu
  // when `slash.slashState` is non-null.
  const slash = useSlashCommandTypeahead({
    value,
    onChange,
    textareaRef,
    slashCommands,
    onSlashMenuIntent,
  });

  // Upload a file and add it as a pending attachment
  const attachFile = useCallback(
    async (file: File) => {
      if (!canvasId) return;
      try {
        if (file.type.startsWith('image/')) {
          const url = await uploadImage(file, canvasId);
          addPendingAttachment({
            type: 'image',
            source: 'upload',
            url,
            label: file.name || 'Image',
          });
        } else if (file.type === 'application/pdf') {
          const url = await uploadPdf(file, canvasId);
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

          const url = await uploadImage(file, canvasId);
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
    [addPendingAttachment, canvasId],
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
    mode === 'operate' ? 'Describe the canvas change you want...' : placeholder;

  // Auto-resize textarea.
  // Runs synchronously before paint to avoid the brief flash where the
  // textarea looks stretched by the parent flex container.
  useLayoutEffect(() => {
    if (mode === 'operate') return;

    const textarea = textareaRef.current;
    if (!textarea) return;

    const computed = window.getComputedStyle(textarea);
    const lineHeightRaw = Number.parseFloat(computed.lineHeight);
    const lineHeight =
      Number.isFinite(lineHeightRaw) && lineHeightRaw > 0 ? lineHeightRaw : 20;

    const paddingY =
      (Number.parseFloat(computed.paddingTop) || 0) +
      (Number.parseFloat(computed.paddingBottom) || 0);
    const borderY =
      (Number.parseFloat(computed.borderTopWidth) || 0) +
      (Number.parseFloat(computed.borderBottomWidth) || 0);

    const minLines = 2;
    const maxLines = 5;
    // With box-sizing: border-box (Tailwind preflight), style.height must
    // include padding + border to match the visible row count.
    const chrome = paddingY + borderY;
    const minHeight = lineHeight * minLines + chrome;
    const maxHeight = lineHeight * maxLines + chrome;

    if (!value) {
      // Empty content — skip scrollHeight measurement because it's unreliable
      // on first mount (layout / fonts not yet settled) and tends to produce
      // a value larger than the actual rows={2} default, making the textarea
      // appear stretched until the user types.
      textarea.style.height = `${minHeight}px`;
      textarea.style.overflowY = 'hidden';
      return;
    }

    // Reset to auto so scrollHeight reflects the intrinsic content height.
    textarea.style.height = 'auto';
    // scrollHeight excludes border per spec — add it back for border-box.
    const measured = textarea.scrollHeight + borderY;
    const nextHeight = Math.max(minHeight, Math.min(measured, maxHeight));
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = measured > maxHeight ? 'auto' : 'hidden';
  }, [mode, value]);

  // Handle Enter key for submission and ArrowUp/ArrowDown for prompt history
  const handleKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement> = (
    e,
  ) => {
    if (disabled) return;
    if (e.nativeEvent.isComposing) return;

    // Slash menu owns ArrowUp/Down/Tab/Enter/Esc while open; bail
    // out the moment it consumes the event so submission and history
    // nav below don't also fire.
    if (slash.handleKeyDown(e)) return;

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
          className={`rounded-2xl border p-3 transition-colors ${isDragOver ? 'border-edge-default bg-info-bg' : 'border-edge-default bg-surface'}`}
        >
          {/* ── Pending attachment thumbnails ── */}
          {(pendingAttachments.length > 0 || selectionAttachment) && (
            <div className="mb-2 flex flex-wrap gap-2">
              {/* Selection attachment (from text highlight in expanded panel) */}
              {selectionAttachment &&
                (() => {
                  const att = selectionAttachment;
                  const sourceNodeId = att.originNodeId;
                  const previewText = att.content ?? att.label ?? 'text';

                  const tooltipParts: React.ReactNode[] = [];
                  if (sourceNodeId) {
                    tooltipParts.push(
                      <div key="src" className="flex items-center gap-1">
                        <span className="text-fg-subtle">Source:</span>
                        <span className="[&>div]:text-fg-inverse [&>div]:border-fg-inverse/30 [&>div:hover]:bg-fg-inverse/10">
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
                      className="group border-edge-default relative flex cursor-pointer items-center justify-center rounded-md border border-dashed"
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
                      <Button
                        variant="ghost"
                        shape="pill"
                        iconOnly
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          useChatStore.getState().setSelectionAttachment(null);
                        }}
                        tooltipWrapperClassName="absolute top-0.5 right-0.5 inline-flex opacity-0 transition-opacity group-hover:opacity-100"
                        className="text-fg-inverse bg-inverse/50 enabled:hover:bg-inverse/70 p-0.5"
                        title="Remove attachment"
                      >
                        <X />
                      </Button>
                      {/* TODO: redundant attachment component, should replace with one common attachment component with pending attribute */}
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
                const sourceNodeId = att.originNodeId;

                // Text preview for the tile
                const previewText =
                  att.content ?? att.label ?? att.filename ?? 'file';

                // Build tooltip content: source + content
                const tooltipParts: React.ReactNode[] = [];
                if (sourceNodeId) {
                  tooltipParts.push(
                    <div key="src" className="flex items-center gap-1">
                      <span className="text-fg-subtle">Source:</span>
                      <span className="[&>div]:text-fg-inverse [&>div]:border-fg-inverse/30 [&>div:hover]:bg-fg-inverse/10">
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
                    className="group border-edge-default relative flex items-center justify-center rounded-md border"
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
                    <Button
                      variant="ghost"
                      iconOnly
                      size="sm"
                      shape="pill"
                      onClick={(e) => {
                        e.stopPropagation();
                        removePendingAttachment(idx);
                      }}
                      tooltipWrapperClassName="absolute top-0.5 right-0.5 inline-flex opacity-0 transition-opacity group-hover:opacity-100"
                      className="text-fg-inverse bg-inverse/50 enabled:hover:bg-inverse/70 p-0.5"
                      title="Remove attachment"
                    >
                      <X />
                    </Button>
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

          <div className="relative">
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => {
                onChange(e.target.value);
                // Caret reads must run AFTER onChange so the slash
                // activation parser sees the committed value.
                slash.syncCaret();
              }}
              onKeyDown={handleKeyDown}
              onKeyUp={slash.syncCaret}
              onClick={slash.syncCaret}
              onSelect={slash.syncCaret}
              onPaste={handlePaste}
              placeholder={currentPlaceholder}
              disabled={disabled}
              rows={2}
              className="text-fg-default placeholder:text-fg-subtle w-full resize-none bg-transparent text-sm focus:outline-none disabled:cursor-not-allowed"
            />
            {slash.slashState && (
              <SlashCommandMenu
                ref={slash.slashMenuRef}
                commands={slashCommands}
                filter={slash.slashState.filter}
                onSelect={slash.acceptSlashCommand}
              />
            )}
          </div>

          <div className="mt-2 flex items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              {acpSelectorsSlot}
              <ContextUsageRing draftText={value} isStreaming={isStreaming} />
            </div>

            <div className="flex items-center gap-2">
              <SourceCount />

              {isStreaming ? (
                <Button
                  variant="solid"
                  shape="pill"
                  iconOnly
                  size="sm"
                  type="button"
                  title="Stop generating"
                  onClick={onStop}
                  aria-label="Stop"
                >
                  <Square />
                </Button>
              ) : (
                <Button
                  variant="solid"
                  shape="pill"
                  iconOnly
                  size="sm"
                  type="submit"
                  title="Send Message"
                  disabled={isSubmitDisabled}
                  aria-label="Send"
                >
                  <ArrowUp />
                </Button>
              )}
            </div>
          </div>
        </div>
      </form>
    </div>
  );
};
