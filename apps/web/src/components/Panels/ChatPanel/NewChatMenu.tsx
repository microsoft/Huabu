/**
 * `NewChatMenu` — the split-button "new chat" control in the ChatPanel
 * header. Replaces the previous `ModeSelector` whose dropdown only
 * became interactive on an *empty* thread (a confusing affordance once
 * the thread had messages: every option looked greyed-out).
 *
 * Layout:
 *   ┌─────┬─────┐
 *   │  +  │  ▾  │
 *   └─────┴─────┘
 *      │     │
 *      │     └─ Opens a menu: pick the (mode, agent) for a brand-new
 *      │        thread. A **Create agent** entry lives in the menu
 *      │        footer; clicking it opens the same Profile editor used
 *      │        by Settings → External Agents, so adding a new external
 *      │        agent never requires leaving the chat surface.
 *      │
 *      └─ Shortcut: starts a new thread bound to the *current* config
 *         (so "+" while chatting with claude → another claude thread).
 *
 * Why a split button instead of "+" plus a separate picker:
 *   - "1 thread = 1 binding" is still the rule, so "switch agent" is
 *     fundamentally "new thread + new binding". Surfacing both halves
 *     in a single control collapses the previous two-step flow (new
 *     thread → change binding) into a single click.
 *   - The most-common action ("new chat, same agent") stays a single
 *     click via the left `+` half.
 *
 * The thread's *current* (mode, binding) is shown as the panel title
 * ("Chat with claude"); this menu is purely about starting a *new*
 * thread, so menu rows are actions, not radio options.
 */

import { ChevronDown, MessageSquare, Plus, Route, Sprout } from 'lucide-react';
import { useCallback, useRef, useState, type ReactNode } from 'react';

import { Button } from '../../Common/Button';
import { cn } from '../../Common/cn';
import { Popover } from '../../Common/Popover';
import { ProfileEditorModal, useDetectedClis } from '../Header/AcpSettings';

import type {
  AcpAgentProfile,
  AgentBinding,
  AgentMode,
} from '@sediment/shared';

export interface NewChatChoice {
  mode: AgentMode;
  binding: AgentBinding;
}

interface NewChatMenuProps {
  /** Built-in mode of the *current* thread. Used to mark the matching menu row. */
  currentMode: AgentMode;
  /** Binding of the *current* thread. Used to mark the matching menu row. */
  currentBinding: AgentBinding;
  /** Configured external-agent profiles available for binding. */
  profiles: AcpAgentProfile[];
  /**
   * Re-fetch the profile list. Invoked after the inline "Create agent"
   * modal saves so the newly-created profile shows up in the menu
   * without requiring the user to open Settings.
   */
  onRefreshProfiles?: () => void | Promise<void>;
  /** Atomic "reset thread + apply (mode, binding)". */
  onSelect: (choice: NewChatChoice) => void;
  /** Disable the control completely (e.g. history not yet loaded). */
  disabled?: boolean;
  /**
   * Disable the new-chat actions (e.g. mid-stream). The menu itself can
   * still be opened so the user can see what's available, but every row
   * is greyed-out.
   */
  busy?: boolean;
}

const INTERNAL: AgentBinding = { kind: 'internal' };

function bindingsEqual(a: AgentBinding, b: AgentBinding): boolean {
  if (a.kind === 'internal' && b.kind === 'internal') return true;
  if (a.kind === 'external' && b.kind === 'external') {
    return a.profileId === b.profileId;
  }
  return false;
}

export const NewChatMenu = ({
  currentMode,
  currentBinding,
  profiles,
  onRefreshProfiles,
  onSelect,
  disabled = false,
  busy = false,
}: NewChatMenuProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const justDismissedRef = useRef(false);
  // CLI detection is cheap (single fetch, cached for the menu's
  // lifetime). We do it eagerly so opening the editor modal feels
  // instant even on a cold mount — same reason the Settings section
  // fetches at mount instead of on dialog-open.
  const detectedClis = useDetectedClis();

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
      ? `New chat with ${currentBinding.alias}`
      : 'New conversation';

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

  const modeItems: { mode: AgentMode; label: string; icon: ReactNode }[] = [
    { mode: 'ask', label: 'Chat', icon: <MessageSquare size={14} /> },
    { mode: 'operate', label: 'Agent', icon: <Sprout size={14} /> },
  ];

  return (
    <>
      <div ref={triggerRef} className="flex items-center">
        <Button
          variant="ghost"
          tone="neutral"
          size="md"
          iconOnly
          onClick={handleShortcut}
          disabled={disabled || busy}
          title={shortcutTitle}
          tooltipPlacement="bottom"
          className="rounded-r-none"
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
          title="Start chat with…"
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
          <div
            role="presentation"
            className="text-fg-muted px-3 pt-1.5 pb-1 text-[10px] tracking-wider uppercase select-none"
          >
            Start new chat with
          </div>
          {modeItems.map((m) => {
            const isCurrent =
              currentBinding.kind === 'internal' && currentMode === m.mode;
            return (
              <MenuRow
                key={`mode:${m.mode}`}
                icon={m.icon}
                label={m.label}
                hint="Huabu"
                current={isCurrent}
                disabled={busy}
                onClick={() =>
                  handleSelect({ mode: m.mode, binding: INTERNAL })
                }
              />
            );
          })}
          {profiles.length > 0 && (
            <div
              role="presentation"
              className="text-fg-muted mt-1 flex items-center gap-2 px-3 pt-1 pb-0.5 text-[10px] tracking-wider uppercase select-none"
            >
              <span className="bg-edge-default h-px flex-1" />
              <span>External Agents</span>
              <span className="bg-edge-default h-px flex-1" />
            </div>
          )}
          {profiles.map((profile) => {
            const binding: AgentBinding = {
              kind: 'external',
              alias: profile.displayName,
              profileId: profile.id,
            };
            const isCurrent = bindingsEqual(currentBinding, binding);
            return (
              <MenuRow
                key={`profile:${profile.id}`}
                icon={<Route size={14} />}
                label={profile.displayName}
                current={isCurrent}
                disabled={busy}
                onClick={() => handleSelect({ mode: currentMode, binding })}
              />
            );
          })}
          {onRefreshProfiles && (
            <>
              <div
                role="presentation"
                className="bg-edge-default mt-1 h-px w-full"
              />
              <div className="px-1 py-1">
                <Button
                  variant="ghost"
                  tone="neutral"
                  size="sm"
                  onClick={() => {
                    // Close the popover before opening the modal so the
                    // two surfaces don't visually stack. The modal then
                    // owns focus management for the rest of the flow.
                    setIsOpen(false);
                    setEditorOpen(true);
                  }}
                  className="w-full justify-start gap-1.5 rounded px-2 py-1.5 text-left"
                >
                  <Plus size={14} />
                  <span className="text-xs">Create agent</span>
                </Button>
              </div>
            </>
          )}
        </Popover>
      )}
      {onRefreshProfiles && (
        <ProfileEditorModal
          isOpen={editorOpen}
          editing={null}
          detectedClis={detectedClis}
          onClose={() => setEditorOpen(false)}
          onSaved={async () => {
            // Refresh the profile list so the newly-created agent
            // appears in this menu (and everywhere else that subscribes
            // to the profiles store) without forcing the user to open
            // Settings or reload the page.
            await onRefreshProfiles();
          }}
        />
      )}
    </>
  );
};

interface MenuRowProps {
  icon: ReactNode;
  label: string;
  hint?: string;
  current?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

const MenuRow = ({
  icon,
  label,
  hint,
  current,
  disabled,
  onClick,
}: MenuRowProps) => (
  <Button
    variant="ghost"
    tone="neutral"
    size="sm"
    role="menuitem"
    disabled={disabled}
    onClick={onClick}
    title={
      current
        ? 'Current — starts another thread with the same setup'
        : undefined
    }
    className={cn(
      'w-full justify-start gap-2 rounded-none px-3 py-1.5 text-left',
      current ? 'text-info' : 'text-fg-default',
    )}
  >
    <span className="shrink-0">{icon}</span>
    <span className="shrink-0">{label}</span>
    {hint && (
      <span className="text-fg-muted ml-auto block min-w-0 truncate pl-2 text-xs">
        {hint}
      </span>
    )}
  </Button>
);
