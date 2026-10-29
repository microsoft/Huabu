// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { AlertCircle, ChevronDown, UserRound } from 'lucide-react';
import { useId, useState } from 'react';
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
  MENU_GROUP_CLASS,
  MENU_SECTION_LABEL_CLASS,
  MENU_SEPARATOR_CLASS,
} from '@/components/Common/menuStyles';
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

  function handleOpenChange(next: boolean) {
    if (next && disabled) return;
    setOpen(next);
    if (next && !open) void onRefreshProfiles();
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
        aria-label={t('toolbar.inkAgentPicker.menuLabel')}
        align="bottom-right"
        // Clear the trigger's 7px toolbar inset, then leave an 8px surface gap.
        offset={{ x: 0, y: 15 }}
        open={open}
        onOpenChange={handleOpenChange}
        className="w-80 max-w-[calc(100vw-24px)]"
        trigger={
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            aria-haspopup="menu"
            aria-label={accessibleLabel}
            aria-describedby={reason ? `${id}-reason` : undefined}
            data-popover-dismiss-ignore=""
            title={t('toolbar.inkAgentPicker.chooseSession')}
            className="ink-agent-destination-trigger max-w-[min(15rem,45vw)] min-w-0"
            onPointerDown={(event) => {
              event.stopPropagation();
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
              <span className="text-fg-muted shrink-0 text-xs">
                {t(
                  continuing
                    ? 'toolbar.inkAgentPicker.continue'
                    : 'toolbar.inkAgentPicker.new',
                )}
              </span>
            )}
            {reason?.kind === 'unavailable' && (
              <AlertCircle size={12} className="text-warning-fg" aria-hidden />
            )}
            <ChevronDown size={12} aria-hidden />
          </Button>
        }
      >
        <div>
          {reason && (
            <p
              role="status"
              className={cn(
                'px-3 py-2 text-xs',
                reason.kind === 'busy' ? 'text-fg-muted' : 'text-warning-fg',
              )}
            >
              {reason.message}
            </p>
          )}
          {conversations.length > 0 && (
            <div
              role="group"
              aria-labelledby={`${id}-continue`}
              className={MENU_GROUP_CLASS}
            >
              <div id={`${id}-continue`} className={MENU_SECTION_LABEL_CLASS}>
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
                      selectedNodeId === conversation.nodeId && 'text-info-fg',
                    )}
                    onClick={() => {
                      if (disabled || conversation.disabledReason) return;
                      onContinueConversation(conversation.nodeId);
                      setOpen(false);
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
          {conversations.length > 0 && (
            <div
              role="separator"
              className={cn(MENU_SEPARATOR_CLASS, 'my-2')}
            />
          )}
          <div
            role="group"
            aria-label={t('toolbar.inkAgentPicker.newConversation')}
            className="[&_[role=menuitem]>span:nth-child(2)]:min-w-0 [&_[role=menuitem]>span:nth-child(2)]:shrink [&_[role=menuitem]>span:nth-child(2)]:truncate"
          >
            <AgentMenuOptions
              heading={t('toolbar.inkAgentPicker.newConversation')}
              currentBinding={
                continuing
                  ? NO_CURRENT_BINDING
                  : (binding ?? NO_CURRENT_BINDING)
              }
              currentMode={mode}
              profiles={profiles}
              builtInModes={['operate']}
              externalGroup="nested"
              busy={disabled}
              onSelect={(choice) => {
                if (disabled) return;
                onNewConversation(choice);
                setOpen(false);
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
