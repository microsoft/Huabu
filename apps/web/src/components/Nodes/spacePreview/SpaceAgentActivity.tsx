// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Bot } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { AgentAvatarMark } from '@/components/Common/AgentAvatarMark';
import { Button } from '@/components/Common/Button';
import {
  DropdownMenu,
  DropdownMenuItem,
} from '@/components/Common/DropdownMenu';
import { Tooltip } from '@/components/Common/Tooltip';
import { CONVERSATION_CARD_SPACING } from '@/components/Nodes/design/nodeSpacing';
import { SPACE_CARD_TYPOGRAPHY } from '@/components/Nodes/design/nodeTypography';
import { useAcpProfilesStore } from '@/store/acpProfilesStore';
import { resolveQuestionAgentPresentation } from '@/utils/questionAgentPresentation';

import { useSpaceAgentFit } from './useSpaceAgentFit';

import type {
  SpaceAgentActivity as Activity,
  SpaceCardAgent,
} from '@huabu/shared';

const BADGE_LAYOUT = 'gap-1.5 rounded-md py-[3px]';
const BADGE_STATUS_CLASSES: Record<SpaceCardAgent['status'], string> = {
  running: 'bg-info-bg text-info-fg enabled:hover:bg-info-bg-hover',
  approval: 'bg-warning-bg text-warning-fg enabled:hover:bg-hover',
  error: 'bg-danger-bg text-danger-fg enabled:hover:bg-hover',
  unread: 'bg-success-bg text-success-fg enabled:hover:bg-hover',
  unknown: 'bg-hover text-fg-muted enabled:hover:bg-edge-default',
  idle: 'bg-hover text-fg-muted enabled:hover:bg-edge-default',
};

export function SpaceAgentActivity({
  activity,
  failed = false,
  errorDetail,
  onOpen,
}: {
  activity?: Activity;
  failed?: boolean;
  errorDetail?: string;
  onOpen?: (agent: SpaceCardAgent) => void;
}) {
  const { t, i18n } = useTranslation();
  const unavailableLabel = t('spacePreview.activityUnavailable');
  const unavailableDescription = errorDetail
    ? `${unavailableLabel}: ${errorDetail}`
    : unavailableLabel;
  const statusLabel = (status: SpaceCardAgent['status']) =>
    t(
      status === 'unknown' || status === 'idle'
        ? `spacePreview.sessionStatus.${status}`
        : `node.questionCard.${status}`,
    );
  const profiles = useAcpProfilesStore((state) => state.profiles);
  const init = useAcpProfilesStore((state) => state.init);
  const hasExternal = activity?.some(
    (entry) => entry.agentBinding?.kind === 'external',
  );
  useEffect(() => {
    if (hasExternal) void init();
  }, [hasExternal, init]);

  const sessions = useMemo(
    () => activity?.filter((entry) => entry.status !== 'idle') ?? [],
    [activity],
  );
  const { rowRef, probesRef, visibleCount } = useSpaceAgentFit(
    sessions,
    i18n.language,
    failed,
  );
  if (activity && !failed && !sessions.length) return null;
  const overflow = sessions.slice(visibleCount);
  const typography = {
    fontSize: SPACE_CARD_TYPOGRAPHY.metadata.size,
    lineHeight: SPACE_CARD_TYPOGRAPHY.metadata.lineHeight,
  };
  const badgeStyle = {
    ...typography,
    paddingInline: CONVERSATION_CARD_SPACING.statusPaddingX,
  };
  const renderSession = (entry: SpaceCardAgent, inMenu = false) => {
    const agent = entry.agentBinding
      ? resolveQuestionAgentPresentation({
          binding: entry.agentBinding,
          fallbackIcon: entry.agentIcon,
          agentMode: entry.agentMode,
          profiles,
        })
      : null;
    const title = entry.title || t('preview.chatTab');
    const status = statusLabel(entry.status);
    const label = t('spacePreview.openConversation', {
      agent: agent?.alias ?? t('spacePreview.unknownAgent'),
      title,
      status,
    });
    const content = (
      <span
        className={`flex min-w-0 flex-1 items-center ${inMenu ? 'gap-2' : 'gap-1.5'}`}
      >
        <span className="flex size-6 shrink-0 items-center justify-center">
          {agent ? (
            <AgentAvatarMark agent={agent} size={24} detail="full" />
          ) : (
            <Bot aria-hidden />
          )}
        </span>
        <span className="min-w-0 truncate">{inMenu ? title : status}</span>
        {inMenu ? (
          <span className="text-fg-muted ml-auto shrink-0">{status}</span>
        ) : null}
      </span>
    );
    const props = {
      className:
        'nodrag nopan focus-visible:outline-info max-w-full justify-start gap-2 p-1 text-left font-normal focus-visible:outline-2 focus-visible:outline-offset-2 [&_svg]:size-6',
      style: typography,
      'aria-label': label,
      'data-space-agent-thread': entry.threadId,
      'data-agent-status': entry.status,
      onClick: (event: React.MouseEvent) => {
        event.stopPropagation();
        onOpen?.(entry);
      },
      onDoubleClick: (event: React.MouseEvent) => event.stopPropagation(),
    };
    return (
      <Tooltip
        key={entry.threadId}
        content={<span className="line-clamp-2">{title}</span>}
        wrapperClassName={inMenu ? 'min-w-0 max-w-full' : 'shrink-0'}
      >
        {!onOpen ? (
          <span
            className={`flex items-center ${BADGE_LAYOUT} ${BADGE_STATUS_CLASSES[entry.status]} [&_svg]:size-6`}
            data-space-agent-badge={entry.status}
            style={badgeStyle}
          >
            {content}
          </span>
        ) : inMenu ? (
          <DropdownMenuItem {...props}>{content}</DropdownMenuItem>
        ) : (
          <Button
            variant="ghost"
            {...props}
            style={badgeStyle}
            className={`${props.className} ${BADGE_LAYOUT} ${BADGE_STATUS_CLASSES[entry.status]}`}
            data-space-agent-badge={entry.status}
            onKeyDown={(event) => event.stopPropagation()}
          >
            {content}
          </Button>
        )}
      </Tooltip>
    );
  };
  return (
    <div
      data-space-agent-activity
      ref={rowRef}
      className="text-fg-muted relative flex h-full min-w-0 flex-1 items-center gap-2 font-normal whitespace-nowrap"
      style={typography}
    >
      {failed ? (
        <Tooltip content={unavailableDescription} wrapperClassName="min-w-0">
          <span
            role="status"
            aria-label={unavailableDescription}
            className="text-warning-fg block truncate"
          >
            {unavailableLabel}
          </span>
        </Tooltip>
      ) : !activity ? (
        <Tooltip
          content={t('spacePreview.activityLoading')}
          wrapperClassName="min-w-0"
        >
          <span role="status" className="block truncate">
            {t('spacePreview.activityLoading')}
          </span>
        </Tooltip>
      ) : (
        <>
          <div
            ref={probesRef}
            aria-hidden
            inert
            className="pointer-events-none invisible absolute inset-0 overflow-hidden"
          >
            <div className="flex w-max">
              {[...new Set(sessions.map((entry) => entry.status))].map(
                (status) => (
                  <span
                    key={status}
                    data-agent-fit-status={status}
                    className={`inline-flex w-max shrink-0 items-center ${BADGE_LAYOUT}`}
                    style={badgeStyle}
                  >
                    <span className="size-6 shrink-0" />
                    {statusLabel(status)}
                  </span>
                ),
              )}
              {Array.from(
                { length: String(sessions.length).length },
                (_, index) => (
                  <span
                    key={index}
                    data-agent-fit-digits={index + 1}
                    className="inline-block w-max shrink-0 px-2 py-1 tabular-nums"
                  >
                    +{10 ** index}
                  </span>
                ),
              )}
            </div>
          </div>
          {sessions.slice(0, visibleCount).map((entry) => renderSession(entry))}
          {overflow.length > 0 ? (
            onOpen ? (
              <DropdownMenu
                floating
                triggerWrapperClassName="shrink-0"
                className="nodrag nopan nowheel max-h-64 w-80 max-w-[calc(100vw-2rem)] overflow-y-auto"
                trigger={
                  <Button
                    variant="ghost"
                    className="nodrag nopan shrink-0 px-2 py-1 font-normal tabular-nums"
                    style={typography}
                    aria-label={t('spacePreview.moreConversations', {
                      count: overflow.length,
                    })}
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    +{overflow.length}
                  </Button>
                }
              >
                {overflow.map((entry) => renderSession(entry, true))}
              </DropdownMenu>
            ) : (
              <span className="shrink-0 px-2 py-1 tabular-nums">
                +{overflow.length}
              </span>
            )
          ) : null}
        </>
      )}
    </div>
  );
}
