// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `AgentSelector` — compact, inline agent picker mounted at the left of
 * the `ChatInput` toolbar.
 *
 * It is the single per-thread agent control:
 *   - While the thread is still empty (`editable`), it is a dropdown the
 *     user can change — Chat / Agent (built-in modes) or any configured
 *     external ACP profile. Picking an option sets the current thread's
 *     binding in place (no new thread minted).
 *   - Once the thread has messages, the binding is locked for its
 *     lifetime, so the control renders as a read-only chip showing which
 *     agent owns the conversation.
 *
 * Both states occupy the same fixed footprint so the toolbar never
 * shifts when a thread transitions from composing to locked: the chevron
 * keeps its slot (just hidden) in read-only mode.
 */

import { ChevronDown } from 'lucide-react';
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { AgentIcon } from '@/components/Common/AgentIcon';
import { resolveQuestionAgentPresentation } from '@/utils/questionAgentPresentation';

import {
  AgentMenuOptions,
  useAddAgentEditor,
  type AgentChoice,
} from './agentMenu';
import { BuiltInAgentAvatar } from '../../Common/BuiltInAgentAvatar';
import { cn } from '../../Common/cn';
import { Popover } from '../../Common/Popover';

import type {
  AgentBinding,
  AgentIcon as AgentIconData,
  AgentMode,
  AgentProfileView,
} from '@huabu/shared';

export type { AgentChoice };

interface AgentSelectorProps {
  /** Binding of the current thread. */
  currentBinding: AgentBinding;
  /** Built-in mode of the current thread (only meaningful for internal). */
  currentMode: AgentMode;
  /** Configured external-agent profiles available for binding. */
  profiles: AgentProfileView[];
  /**
   * When true the selector is interactive (thread still empty). When
   * false it is a read-only chip (binding locked for the thread).
   */
  editable: boolean;
  /** Apply a picked (mode, binding) to the current thread. */
  onSelect: (choice: AgentChoice) => void;
  /** Re-fetch the profile list (after the inline "Add agent" modal saves). */
  onRefreshProfiles?: () => void | Promise<void>;
  /** Disable the control completely (e.g. history not yet loaded). */
  disabled?: boolean;
  /**
   * Bind-time avatar snapshot for an external binding whose Profile no
   * longer exists (question-node `agentIcon`). Preserves the historical
   * identity in the read-only chip instead of falling back to a generic
   * icon, mirroring the canvas node.
   */
  fallbackIcon?: AgentIconData;
}

/** Icon + label describing the currently-bound agent. */
function describeBinding(
  binding: AgentBinding,
  mode: AgentMode,
  labels: { chat: string; agent: string },
  profiles: AgentProfileView[],
  fallbackIcon?: AgentIconData,
): { icon: ReactNode; label: string } {
  // Share the external-binding resolution policy with the canvas question
  // node (live Profile → bind-time snapshot → deterministic default), so a
  // deleted Profile shows the same identity here as on the canvas. Only the
  // rendering differs: the chip needs a ReactNode and the built-in agent's
  // ask/operate faces, which the presentation helper does not model.
  const presentation = resolveQuestionAgentPresentation({
    binding,
    fallbackIcon,
    profiles,
  });
  if (presentation.kind === 'external') {
    return {
      icon: (
        <AgentIcon
          shape={presentation.icon.shape}
          color={presentation.icon.color}
          size={16}
          withFace
        />
      ),
      label: presentation.alias,
    };
  }
  return mode === 'operate'
    ? {
        icon: <BuiltInAgentAvatar mode="operate" size={16} />,
        label: labels.agent,
      }
    : { icon: <BuiltInAgentAvatar mode="ask" size={16} />, label: labels.chat };
}

export const AgentSelector = ({
  currentBinding,
  currentMode,
  profiles,
  editable,
  onSelect,
  onRefreshProfiles,
  disabled = false,
  fallbackIcon,
}: AgentSelectorProps) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
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
    if (disabled || !editable) return;
    if (justDismissedRef.current) return;
    setIsOpen((prev) => {
      const next = !prev;
      // Refresh the profile list on the rising edge so a freshly-added
      // agent shows up without reopening the panel.
      if (next) void onRefreshProfiles?.();
      return next;
    });
  }, [disabled, editable, onRefreshProfiles]);

  const handleSelect = useCallback(
    (choice: AgentChoice) => {
      onSelect(choice);
      setIsOpen(false);
    },
    [onSelect],
  );

  const computePosition = useCallback(() => {
    if (!triggerRef.current) return { x: 0, y: 0 };
    const rect = triggerRef.current.getBoundingClientRect();
    return { x: rect.left, y: rect.top };
  }, []);

  const current = describeBinding(
    currentBinding,
    currentMode,
    {
      chat: t('chat.modeChat'),
      agent: t('chat.modeAgent'),
    },
    profiles,
    fallbackIcon,
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={handleToggle}
        disabled={disabled || !editable}
        aria-expanded={editable ? isOpen : undefined}
        title={
          editable
            ? t('chat.chooseAgent')
            : t('chat.agentLabel', { label: current.label })
        }
        className={cn(
          'flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-xs',
          'text-fg-muted',
          editable
            ? 'hover:bg-hover hover:text-fg-default cursor-pointer'
            : 'cursor-default',
          isOpen && 'bg-bg-default text-fg-default',
        )}
      >
        <span className="flex shrink-0 items-center">{current.icon}</span>
        <span className="min-w-0 flex-1 truncate text-left">
          {current.label}
        </span>
        <ChevronDown
          size={12}
          className={cn(
            'shrink-0 transition-transform',
            !editable && 'invisible',
            isOpen && 'rotate-180',
          )}
        />
      </button>
      {editable && isOpen && (
        <Popover
          position={computePosition()}
          onDismiss={handleDismiss}
          anchor="bottom-left"
          offset={{ x: 0, y: -4 }}
          className="flex max-w-[min(20rem,calc(100vw-1rem))] flex-col overflow-hidden py-1"
        >
          <AgentMenuOptions
            heading={t('chat.agentHeading')}
            currentBinding={currentBinding}
            currentMode={currentMode}
            profiles={profiles}
            currentRowTitle={t('chat.currentAgentThread')}
            onSelect={handleSelect}
            onAddAgent={
              onRefreshProfiles
                ? () => {
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
