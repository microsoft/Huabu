// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { AlertCircle, ChevronDown, UserRound } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AgentAvatarMark } from '@/components/Common/AgentAvatarMark';
import { Button } from '@/components/Common/Button';
import { cn } from '@/components/Common/cn';
import {
  DropdownMenu,
  DropdownMenuItem,
} from '@/components/Common/DropdownMenu';
import { FLOATING_CHROME_PROPS } from '@/components/Common/floatingChrome';
import {
  AgentMenuOptions,
  type AgentChoice,
} from '@/components/Panels/ChatPanel/agentMenu';
import { resolveQuestionAgentPresentation } from '@/utils/questionAgentPresentation';

import type {
  AgentBinding,
  AgentIcon,
  AgentMode,
  AgentProfileView,
} from '@huabu/shared';

export interface InkAgentDestinationIssue {
  kind: 'busy' | 'unavailable';
  message: string;
}

export interface InkAgentConversationOption {
  nodeId: string;
  title: string;
  binding: AgentBinding;
  mode: AgentMode;
  fallbackIcon?: AgentIcon;
  disabledReason?: InkAgentDestinationIssue;
}

export interface InkAgentDestinationPickerProps {
  binding: AgentBinding | null;
  mode: AgentMode;
  profiles: AgentProfileView[];
  conversations: InkAgentConversationOption[];
  selectedNodeId?: string;
  unresolved?: boolean;
  loading?: boolean;
  disabled?: boolean;
  unavailableReason?: InkAgentDestinationIssue;
  onNewConversation: (choice: AgentChoice) => void;
  onContinueConversation: (nodeId: string) => void;
  onRefreshProfiles: () => void | Promise<void>;
}

// The shared menu requires a binding; an empty Profile ID matches no choice.
const NO_CURRENT_BINDING: AgentBinding = {
  kind: 'external',
  profileId: '',
  alias: '',
};

export function InkAgentDestinationPicker({
  binding,
  mode,
  profiles,
  conversations,
  selectedNodeId,
  unresolved = false,
  loading = false,
  disabled = false,
  unavailableReason,
  onNewConversation,
  onContinueConversation,
  onRefreshProfiles,
}: InkAgentDestinationPickerProps) {
  const { t } = useTranslation();
  const id = useId();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const keyboardOpen = useRef<'first' | 'last' | null>(null);
  const continuing = selectedNodeId !== undefined;
  const selected = conversations.find(
    (conversation) => conversation.nodeId === selectedNodeId,
  );
  const currentBinding = continuing ? (selected?.binding ?? binding) : binding;
  const agent = currentBinding
    ? resolveQuestionAgentPresentation({
        binding: currentBinding,
        profiles,
        agentMode: selected?.mode ?? mode,
        fallbackIcon: selected?.fallbackIcon,
      })
    : null;
  const agentName = agent
    ? agent.kind === 'external'
      ? agent.alias
      : t(agent.mode === 'operate' ? 'chat.modeAgent' : 'chat.modeChat')
    : '';
  const label = continuing
    ? (selected?.title ?? t('toolbar.inkAgentPicker.unavailableConversation'))
    : unresolved
      ? t(
          loading
            ? 'toolbar.inkAgentPicker.loadingConversation'
            : 'toolbar.inkAgentPicker.chooseConversation',
        )
      : agentName || t('toolbar.inkAgentPicker.chooseAgent');
  const reason =
    unavailableReason ??
    selected?.disabledReason ??
    (continuing && !selected
      ? {
          kind: 'unavailable' as const,
          message: t('toolbar.inkAgentPicker.unavailableConversation'),
        }
      : undefined);
  const accessibleLabel = unresolved
    ? label
    : continuing
      ? t('toolbar.inkAgentPicker.continueDestinationLabel', {
          title: label,
          agent: agentName,
        })
      : agent
        ? t('toolbar.inkAgentPicker.newDestinationLabel', { agent: agentName })
        : t('toolbar.inkAgentPicker.chooseAgent');

  function focusMenu(edge: 'first' | 'last') {
    const items = menuRef.current?.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]:not(:disabled)',
    );
    const item = edge === 'last' ? items?.[items.length - 1] : items?.[0];
    (item ?? menuRef.current)?.focus({ preventScroll: true });
  }

  function handleOpenChange(next: boolean) {
    if (next && disabled) return;
    setOpen(next);
    if (next && !open) void onRefreshProfiles();
  }

  function closeAfterChoice() {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  }

  return (
    <div
      {...FLOATING_CHROME_PROPS}
      role="presentation"
      className="min-w-0 shrink-0"
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {/* Coordinate positioning clamps vertically even when neither side fits. */}
      <DropdownMenu
        align="bottom-right"
        // Clear the trigger's 7px toolbar inset, then leave an 8px surface gap.
        offset={{ x: 0, y: 15 }}
        open={open}
        onOpenChange={handleOpenChange}
        onOpenAutoFocus={() => {
          focusMenu(keyboardOpen.current ?? 'first');
        }}
        className="w-80 max-w-[calc(100vw-24px)]"
        trigger={
          <Button
            ref={triggerRef}
            variant="ghost"
            size="sm"
            disabled={disabled}
            aria-haspopup="menu"
            aria-controls={open ? `${id}-menu` : undefined}
            aria-label={accessibleLabel}
            aria-describedby={reason ? `${id}-reason` : undefined}
            data-popover-dismiss-ignore=""
            title={t('toolbar.inkAgentPicker.chooseSession')}
            className="ink-agent-destination-trigger max-w-[min(15rem,45vw)] min-w-0"
            onPointerDown={(event) => {
              keyboardOpen.current = null;
              event.stopPropagation();
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                event.stopPropagation();
                keyboardOpen.current =
                  event.key === 'ArrowUp' ? 'last' : 'first';
                if (open) focusMenu(keyboardOpen.current);
                else handleOpenChange(true);
              } else if (event.key === 'Enter' || event.key === ' ') {
                event.stopPropagation();
                keyboardOpen.current = 'first';
              }
            }}
          >
            <span className="shrink-0" aria-hidden>
              {agent ? (
                <AgentAvatarMark agent={agent} size={16} detail="full" />
              ) : (
                <UserRound size={16} />
              )}
            </span>
            <span className="min-w-0 truncate">{label}</span>
            {(agent || continuing) && (
              <span className="text-fg-subtle shrink-0 text-[10px]">
                {t(
                  continuing
                    ? 'toolbar.inkAgentPicker.continue'
                    : 'toolbar.inkAgentPicker.new',
                )}
              </span>
            )}
            {reason?.kind === 'unavailable' && (
              <AlertCircle size={12} className="text-warning" aria-hidden />
            )}
            <ChevronDown size={12} aria-hidden />
          </Button>
        }
      >
        <div
          ref={menuRef}
          id={`${id}-menu`}
          role="menu"
          tabIndex={-1}
          aria-label={t('toolbar.inkAgentPicker.menuLabel')}
          className="max-h-[min(24rem,calc(100dvh-40px))] overflow-y-auto overscroll-contain"
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Tab') {
              setOpen(false);
              triggerRef.current?.focus({ preventScroll: true });
              return;
            }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key))
              return;
            event.preventDefault();
            const items = [
              ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                '[role="menuitem"]:not(:disabled)',
              ),
            ];
            if (!items.length) return;
            const index = items.findIndex(
              (item) => item === document.activeElement,
            );
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? items.length - 1
                  : index < 0
                    ? event.key === 'ArrowUp'
                      ? items.length - 1
                      : 0
                    : (index +
                        (event.key === 'ArrowDown' ? 1 : -1) +
                        items.length) %
                      items.length;
            items[next]?.focus({ preventScroll: true });
            items[next]?.scrollIntoView({ block: 'nearest' });
          }}
        >
          {reason && (
            <p
              role="status"
              className={cn(
                'px-3 py-2 text-xs',
                reason.kind === 'busy' ? 'text-fg-muted' : 'text-warning',
              )}
            >
              {reason.message}
            </p>
          )}
          {conversations.length > 0 && (
            <div role="group" aria-labelledby={`${id}-continue`}>
              <div
                id={`${id}-continue`}
                className="text-fg-muted px-3 pt-1.5 pb-1 text-[10px] tracking-wider uppercase"
              >
                {t('toolbar.inkAgentPicker.continueCanvas')}
              </div>
              {conversations.map((conversation) => {
                const identity = resolveQuestionAgentPresentation({
                  binding: conversation.binding,
                  profiles,
                  agentMode: conversation.mode,
                  fallbackIcon: conversation.fallbackIcon,
                });
                const name =
                  identity.kind === 'external'
                    ? identity.alias
                    : t(
                        identity.mode === 'operate'
                          ? 'chat.modeAgent'
                          : 'chat.modeChat',
                      );
                return (
                  <DropdownMenuItem
                    key={conversation.nodeId}
                    icon={
                      <AgentAvatarMark
                        agent={identity}
                        size={16}
                        detail="full"
                      />
                    }
                    disabled={disabled || !!conversation.disabledReason}
                    aria-current={
                      selectedNodeId === conversation.nodeId ? true : undefined
                    }
                    className={cn(
                      'h-auto py-2',
                      selectedNodeId === conversation.nodeId && 'text-info',
                    )}
                    onClick={() => {
                      if (disabled || conversation.disabledReason) return;
                      onContinueConversation(conversation.nodeId);
                      closeAfterChoice();
                    }}
                  >
                    <span className="block truncate">{conversation.title}</span>
                    <span className="text-fg-muted block truncate text-xs">
                      {name}
                    </span>
                    {conversation.disabledReason && (
                      <span className="text-fg-muted block text-xs whitespace-normal">
                        {conversation.disabledReason.message}
                      </span>
                    )}
                  </DropdownMenuItem>
                );
              })}
            </div>
          )}
          <div
            role="group"
            aria-label={t('toolbar.inkAgentPicker.newConversation')}
            className={cn(
              '[&_[role=menuitem]>span:nth-child(2)]:min-w-0 [&_[role=menuitem]>span:nth-child(2)]:shrink [&_[role=menuitem]>span:nth-child(2)]:truncate',
              conversations.length > 0 && 'border-edge-default mt-1 border-t',
            )}
          >
            <AgentMenuOptions
              heading={t('toolbar.inkAgentPicker.newConversation')}
              externalHeadingStyle="subheading"
              currentBinding={
                continuing
                  ? NO_CURRENT_BINDING
                  : (binding ?? NO_CURRENT_BINDING)
              }
              currentMode={mode}
              profiles={profiles}
              busy={disabled}
              onSelect={(choice) => {
                if (disabled) return;
                onNewConversation(choice);
                closeAfterChoice();
              }}
            />
          </div>
        </div>
      </DropdownMenu>
      {reason && (
        <span id={`${id}-reason`} className="sr-only">
          {reason.message}
        </span>
      )}
    </div>
  );
}
