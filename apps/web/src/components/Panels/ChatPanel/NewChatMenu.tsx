/**
 * `NewChatMenu` — the split-button "new chat" control in the ChatPanel
 * header. Replaces the previous `ModeSelector` whose dropdown only
 * became interactive on an *empty* thread (a confusing affordance once
 * the thread had messages: every option looked greyed-out).
 */

import { Bookmark, ChevronDown, Plus } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  AgentMenuOptions,
  useAddAgentEditor,
  type AgentChoice,
} from './agentMenu';
import { Button } from '../../Common/Button';
import { cn } from '../../Common/cn';
import { Popover } from '../../Common/Popover';

import type {
  AcpAgentProfile,
  AgentBinding,
  AgentMode,
} from '@sediment/shared';

export type NewChatChoice = AgentChoice;

interface NewChatMenuProps {
  /** Built-in mode of the *current* thread. Used to mark the matching menu row. */
  currentMode: AgentMode;
  /** Binding of the *current* thread. Used to mark the matching menu row. */
  currentBinding: AgentBinding;
  /** Configured external-agent profiles available for binding. */
  profiles: AcpAgentProfile[];
  /**
   * Re-fetch the profile list. Invoked after the inline "Add agent"
   * modal saves so the newly-created profile shows up in the menu
   * without requiring the user to open Settings.
   */
  onRefreshProfiles?: () => void | Promise<void>;
  /** Atomic "reset thread + apply (mode, binding)". */
  onSelect: (choice: NewChatChoice) => void;
  onSave?: () => void;
  canSave?: boolean;
  /** Disable the control completely (e.g. history not yet loaded). */
  disabled?: boolean;
  /**
   * Disable the new-chat actions (e.g. mid-stream). The menu itself can
   * still be opened so the user can see what's available, but every row
   * is greyed-out.
   */
  busy?: boolean;
}

export const NewChatMenu = ({
  currentMode,
  currentBinding,
  profiles,
  onRefreshProfiles,
  onSelect,
  onSave,
  canSave = false,
  disabled = false,
  busy = false,
}: NewChatMenuProps) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const justDismissedRef = useRef(false);
  const { openEditor, editor } = useAddAgentEditor(onRefreshProfiles);

  const handleDismiss = useCallback(() => {
    justDismissedRef.current = true;
    setIsOpen(false);
    requestAnimationFrame(() => {
      justDismissedRef.current = false;
    });
  }, []);

  const handleToggle = useCallback(() => {
    if (disabled) return;
    if (justDismissedRef.current) return;
    setIsOpen((prev) => !prev);
  }, [disabled]);

  const computePosition = useCallback(() => {
    if (!triggerRef.current) return { x: 0, y: 0 };
    const rect = triggerRef.current.getBoundingClientRect();
    return { x: rect.right, y: rect.bottom };
  }, []);

  const shortcutTitle =
    currentBinding.kind === 'external'
      ? t('chat.newChatWith', { name: currentBinding.alias })
      : t('chat.newConversation');

  const handleShortcut = useCallback(() => {
    if (disabled || busy) return;
    onSelect({ mode: currentMode, binding: currentBinding });
  }, [disabled, busy, onSelect, currentMode, currentBinding]);

  const handleSelect = useCallback(
    (choice: NewChatChoice) => {
      onSelect(choice);
      setIsOpen(false);
    },
    [onSelect],
  );

  return (
    <>
      <div ref={triggerRef} className="flex items-center">
        {onSave && (
          <Button
            variant="ghost"
            tone="neutral"
            size="md"
            iconOnly
            onClick={onSave}
            disabled={disabled || busy || !canSave}
            title={t('chat.saveAsQuestion')}
            tooltipPlacement="bottom"
            className="rounded-r-none"
          >
            <Bookmark />
          </Button>
        )}
        <Button
          variant="ghost"
          tone="neutral"
          size="md"
          iconOnly
          onClick={handleShortcut}
          disabled={disabled || busy}
          title={shortcutTitle}
          tooltipPlacement="bottom"
          className={cn(onSave ? 'rounded-none' : 'rounded-r-none')}
        >
          <Plus />
        </Button>
        <Button
          variant="ghost"
          tone="neutral"
          size="md"
          iconOnly
          onClick={handleToggle}
          disabled={disabled}
          aria-expanded={isOpen}
          title={t('chat.startChatWith')}
          tooltipPlacement="bottom"
          className={cn(
            'rounded-l-none px-0.5 [&_svg]:h-3 [&_svg]:w-3',
            isOpen && 'bg-bg-default',
          )}
        >
          <ChevronDown
            className={cn('transition-transform', isOpen && 'rotate-180')}
          />
        </Button>
      </div>
      {isOpen && (
        <Popover
          position={computePosition()}
          onDismiss={handleDismiss}
          anchor="top-right"
          offset={{ x: 0, y: 4 }}
          className="flex max-w-[min(20rem,calc(100vw-1rem))] flex-col overflow-hidden py-1"
        >
          <AgentMenuOptions
            heading={t('chat.startNewChatWith')}
            currentBinding={currentBinding}
            currentMode={currentMode}
            profiles={profiles}
            busy={busy}
            currentRowTitle={t('chat.currentStartsSameSetup')}
            onSelect={handleSelect}
            onAddAgent={
              onRefreshProfiles
                ? () => {
                    // Close the popover before opening the modal so the
                    // two surfaces don't visually stack.
                    setIsOpen(false);
                    openEditor();
                  }
                : undefined
            }
          />
        </Popover>
      )}
      {editor}
    </>
  );
};
