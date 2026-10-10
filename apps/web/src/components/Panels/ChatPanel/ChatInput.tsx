// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { ArrowUp, Square } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { uploadImage, uploadPdf } from '@/api/artifact';
import { useChatSession } from '@/hooks/useChatSession';
import { selectThreadMessages, useChatStore } from '@/store/chatStore';
import { usePanelStore } from '@/store/panelStore';

import { ChatContextSources } from './ChatContextSources';
import { ContextUsageRing } from './ContextUsageRing';
import { NodeMentionMenu } from './NodeMentionMenu';
import { SlashCommandMenu } from './SlashCommandMenu';
import { useNodeMentionTypeahead } from './useNodeMentionTypeahead';
import { useSlashCommandTypeahead } from './useSlashCommandTypeahead';
import { Button } from '../../Common/Button';

import type { ContextUsageOverride } from './ContextUsageRing';
import type { AgentMode, AvailableCommand } from '@huabu/shared';

export interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (e: React.FormEvent, mode: AgentMode) => void;
  /** Reports a persistent composer mutation to the owning preview surface. */
  onCommit?: () => void;
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
   * True while the ACP slash-command list is being (re)fetched. Lets
   * the typeahead show a loading affordance on a cold agent spawn
   * instead of suppressing the menu entirely.
   */
  slashLoading?: boolean;
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
  /**
   * Slot rendered at the very left of the toolbar, before
   * `acpSelectorsSlot`. ChatPanel mounts the inline `AgentSelector`
   * here so picking / displaying the thread's agent sits right under
   * the text the user is typing.
   */
  agentSelectorSlot?: React.ReactNode;
  /**
   * Authoritative context usage forwarded straight to
   * `ContextUsageRing`. Set by ChatPanel for ACP-bound threads so the
   * ring reflects the agent's own token budget instead of the
   * built-in pi-agent's. See `ContextUsageRing` for the three-state
   * semantics of this prop.
   */
  contextUsageOverride?: ContextUsageOverride | undefined;
  /** Active node shown in the other Preview split group. */
  adjacentNodeSourceId?: string;
  disabled?: boolean;
  placeholder?: string;
  /**
   * When true, the change-review card is attached directly above the
   * input, so the input flattens its top corners to merge into one
   * connected box.
   */
  connectedTop?: boolean;
}

export const ChatInput = ({
  value,
  onChange,
  onSubmit,
  onCommit,
  onStop,
  isStreaming = false,
  mode,
  slashCommands = [],
  slashLoading = false,
  onSlashMenuIntent,
  acpSelectorsSlot,
  agentSelectorSlot,
  contextUsageOverride,
  adjacentNodeSourceId,
  disabled = false,
  placeholder,
  connectedTop = false,
}: ChatInputProps) => {
  const { t } = useTranslation();
  const isSubmitDisabled = disabled || !value.trim();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const historyIndexRef = useRef(-1);
  const draftRef = useRef('');

  // Pending attachments belong to the thread this composer is sending to.
  const { threadId, canvasId } = useChatSession();
  const addPendingAttachment = useChatStore((s) => s.addPendingAttachment);
  const [isDragOver, setIsDragOver] = useState(false);

  // Focus the textarea when a surface asks for *this* thread's composer.
  // Keyed on a nonce so repeated requests re-fire even without an
  // intervening blur.
  const focusRequest = usePanelStore((s) => s.focusChatInputRequest);
  const focusNonce =
    focusRequest?.threadId === threadId ? focusRequest.nonce : null;
  useEffect(() => {
    if (focusNonce === null) return;
    // Defer to the next frame so the panel has finished expanding and the
    // textarea is mounted + interactive before we move focus to it.
    const raf = requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus({ preventScroll: true });
      const len = ta.value.length;
      ta.selectionStart = len;
      ta.selectionEnd = len;
    });
    return () => cancelAnimationFrame(raf);
  }, [focusNonce]);

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
    loading: slashLoading,
    onSlashMenuIntent,
  });
  const mention = useNodeMentionTypeahead({
    value,
    onChange,
    onCommit,
    textareaRef,
    disabled,
  });
  const syncCaret = () => {
    slash.syncCaret();
    mention.syncCaret();
  };

  // Upload a file and add it as a pending attachment
  const attachFile = useCallback(
    async (file: File) => {
      if (!canvasId) return;
      try {
        if (file.type.startsWith('image/')) {
          const url = await uploadImage(file, canvasId);
          addPendingAttachment(threadId, {
            type: 'image',
            source: 'upload',
            url,
            label: file.name || t('chat.attachmentFallbackImage'),
          });
        } else if (file.type === 'application/pdf') {
          const url = await uploadPdf(file, canvasId);
          addPendingAttachment(threadId, {
            type: 'pdf',
            source: 'upload',
            url,
            label: file.name || t('chat.attachmentFallbackPdf'),
            filename: file.name,
          });
        } else {
          // Read text content for text-based files
          const isText =
            file.type.startsWith('text/') ||
            /\.(md|txt|csv|json|xml|yaml|yml|log)$/i.test(file.name);
          const textContent = isText ? await file.text() : undefined;

          const url = await uploadImage(file, canvasId);
          addPendingAttachment(threadId, {
            type: 'file',
            source: 'upload',
            url,
            content: textContent,
            label: file.name || t('chat.attachmentFallbackFile'),
            filename: file.name,
          });
        }
        onCommit?.();
      } catch (err) {
        console.error('Failed to upload file:', err);
      }
    },
    [addPendingAttachment, canvasId, onCommit, t, threadId],
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
    mode === 'operate'
      ? t('chat.operatePlaceholder')
      : (placeholder ?? t('chat.inputPlaceholder'));

  // Handle Enter key for submission and ArrowUp/ArrowDown for prompt history
  const handleKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement> = (
    e,
  ) => {
    if (disabled) return;
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (mention.handleKeyDown(e)) return;

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
        const history = selectThreadMessages(useChatStore.getState(), threadId)
          .filter((m) => m.role === 'user')
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
    // While a turn is streaming the input stays editable, but Enter must not
    // send: the visible action is Stop, and the draft is held for next round.
    if (isStreaming) return;
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
          data-chat-input-surface
          className={`group/composer focus-within:border-info focus-within:ring-info/15 relative border px-3 pt-3 pb-2 transition-colors focus-within:ring-2 ${connectedTop ? 'rounded-t-none rounded-b-2xl' : 'rounded-2xl'} ${isDragOver ? 'border-edge-default bg-info-bg' : 'border-edge-default bg-surface'}`}
        >
          {mention.open ? <NodeMentionMenu mention={mention} /> : null}
          <ChatContextSources
            adjacentNodeSourceId={adjacentNodeSourceId}
            onCommit={onCommit}
          />

          <div className="relative">
            <textarea
              ref={textareaRef}
              name="agent-message"
              autoComplete="off"
              aria-label={currentPlaceholder}
              aria-autocomplete="list"
              aria-controls={mention.open ? mention.menuId : undefined}
              aria-activedescendant={mention.activeOptionId}
              value={value}
              onChange={(e) => {
                onChange(e.target.value);
                // Caret reads must run AFTER onChange so the slash
                // activation parser sees the committed value.
                syncCaret();
              }}
              onKeyDown={handleKeyDown}
              onKeyUp={syncCaret}
              onClick={syncCaret}
              onSelect={syncCaret}
              onFocus={mention.onFocus}
              onBlur={mention.onBlur}
              onCompositionStart={mention.onCompositionStart}
              onCompositionEnd={mention.onCompositionEnd}
              onPaste={handlePaste}
              placeholder={currentPlaceholder}
              disabled={disabled}
              rows={2}
              className="text-fg-default placeholder:text-fg-subtle w-full resize-none bg-transparent text-sm focus:outline-none disabled:cursor-not-allowed"
            />
            {!mention.open && slash.slashState && (
              <SlashCommandMenu
                ref={slash.slashMenuRef}
                commands={slashCommands}
                filter={slash.slashState.filter}
                loading={slash.slashState.loading}
                onSelect={slash.acceptSlashCommand}
              />
            )}
          </div>

          {/* ACP selectors and send / stop stay separate from source context. */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-1 items-center overflow-hidden">
              {acpSelectorsSlot}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {isStreaming ? (
                <Button
                  variant="solid"
                  shape="pill"
                  iconOnly
                  size="sm"
                  type="button"
                  title={t('chat.stopGenerating')}
                  onClick={(event) => {
                    event.preventDefault();
                    onStop();
                  }}
                  aria-label={t('chat.stop')}
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
                  title={t('chat.sendMessage')}
                  disabled={isSubmitDisabled}
                  aria-label={t('chat.send')}
                >
                  <ArrowUp />
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* Agent and context usage sit below the input box. */}
        <div className="mt-1 flex items-center justify-between gap-3 px-1">
          <div className="flex min-w-0 flex-1 items-center overflow-hidden">
            {agentSelectorSlot}
          </div>
          <span className="inline-flex shrink-0 items-center">
            <ContextUsageRing
              isStreaming={isStreaming}
              usageOverride={contextUsageOverride}
            />
          </span>
        </div>
      </form>
    </div>
  );
};
