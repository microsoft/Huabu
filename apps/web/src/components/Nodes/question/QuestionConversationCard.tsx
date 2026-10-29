// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  Check,
  CircleAlert,
  LoaderCircle,
  MessageCircle,
  Pencil,
  ShieldQuestion,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { NODE_SHELL_INSET } from '@huabu/shared/canvas-engine';

import { AgentAvatarMark } from '@/components/Common/AgentAvatarMark';
import { Tooltip } from '@/components/Common/Tooltip';
import {
  QUESTION_FONT_FAMILY,
  QUESTION_NODE_DEFAULT_FONT_SIZE,
  QUESTION_NODE_AGENT_INSET,
  QUESTION_NODE_HEADER_HEIGHT,
  QUESTION_NODE_HEADER_GAP,
  QUESTION_NODE_HEADER_INSET,
  QUESTION_NODE_STATUS_SIZE,
  QUESTION_NODE_STATUS_PADDING_X,
  QUESTION_NODE_TITLE_WEIGHT,
} from '@/utils/node/nodeFontConfig';

import { resolveQuestionTakeoverTone } from './QuestionTakeoverMark';
import { nodeAccentToken } from '../design/nodeAccentPolicy';
import {
  NODE_BORDER_WIDTH,
  nodeBoundaryForAccent,
} from '../design/nodeBoundary';
import { CONVERSATION_CARD_SPACING } from '../design/nodeSpacing';
import { NODE_TYPOGRAPHY } from '../design/nodeTypography';
import { noteSurfaceStyle } from '../note/noteDesign';
import { CardTitle, type CardTitleEditor } from '../shared/CardTitle';
import { NodeActivityTime } from '../shared/NodeActivityTime';
import { resolveTextBodyBox } from '../shared/TextNodeBody';

import type { QuestionAgentBadgeStatus } from './questionBadgeChrome';
import type { TextNodeBodyProps } from '../shared/TextNodeBody';
import type { QuestionAgentPresentation } from '@/utils/questionAgentPresentation';
import type { CSSProperties } from 'react';

export function resolveQuestionCardState(
  status: QuestionAgentBadgeStatus | 'idle',
  unread: boolean,
  conflictCount: number,
  isOpen = false,
) {
  if (status === 'idle' && isOpen) return 'open';
  if (status === 'done') {
    if (conflictCount > 0) return 'conflict';
    return unread ? 'unread' : 'viewed';
  }
  return status;
}

export function QuestionConversationCard({
  agent,
  status,
  isOpen = false,
  unread,
  conflictCount,
  errorMessage,
  lastActivityAt,
  accent,
  text,
  placeholder,
  effectiveWidth,
  effectiveHeight,
  effectiveFontSize,
  paddingX,
  paddingY,
  selected,
  titleEditor,
}: Pick<
  TextNodeBodyProps,
  | 'effectiveWidth'
  | 'effectiveHeight'
  | 'effectiveFontSize'
  | 'paddingX'
  | 'paddingY'
> & {
  agent: QuestionAgentPresentation;
  status: QuestionAgentBadgeStatus | 'idle';
  isOpen?: boolean;
  unread: boolean;
  conflictCount: number;
  errorMessage?: string;
  lastActivityAt?: number;
  accent?: string | null;
  text: string;
  placeholder: string;
  selected?: boolean;
  titleEditor?: CardTitleEditor;
}) {
  const { t } = useTranslation();
  const scale = effectiveFontSize / QUESTION_NODE_DEFAULT_FONT_SIZE;
  const statusIconSize = QUESTION_NODE_STATUS_SIZE * scale;
  const statusPaddingX = QUESTION_NODE_STATUS_PADDING_X * scale;
  const state = resolveQuestionCardState(status, unread, conflictCount, isOpen);
  const tone = resolveQuestionTakeoverTone(status, unread, conflictCount);
  const box = resolveTextBodyBox({
    width: effectiveWidth,
    height: effectiveHeight,
    paddingX,
    paddingY,
  });
  const label = t(`node.questionCard.${state}`);
  const Icon =
    state === 'running'
      ? LoaderCircle
      : state === 'approval'
        ? ShieldQuestion
        : state === 'error' || state === 'conflict'
          ? CircleAlert
          : state === 'viewed'
            ? Check
            : state === 'idle'
              ? Pencil
              : MessageCircle;
  const resolvedAccent = nodeAccentToken('question', accent);
  const description =
    state === 'unread'
      ? t('node.questionCard.unreadDescription')
      : state === 'conflict'
        ? t('node.agentChangesSkipped', { count: conflictCount })
        : state === 'error' && errorMessage
          ? errorMessage
          : label;
  return (
    <div
      className="question-conversation-card"
      data-state={state}
      data-tone={tone}
      data-open={isOpen}
      style={
        {
          // Bleed over the shared transparent shell inset without changing its
          // interaction geometry. The full authored card scales down to 10%.
          width: box.width + NODE_SHELL_INSET,
          height: titleEditor?.error ? 'auto' : box.height,
          minHeight: box.height,
          margin: -NODE_SHELL_INSET / 2,
          padding: `${box.paddingY - QUESTION_NODE_HEADER_INSET * scale}px ${Math.max(0, paddingX - QUESTION_NODE_AGENT_INSET * scale)}px`,
          ...noteSurfaceStyle(resolvedAccent),
          fontFamily: QUESTION_FONT_FAMILY,
          '--question-scale': scale,
          '--question-card-edge':
            nodeBoundaryForAccent(resolvedAccent).borderColor,
          '--question-edge-width': `${NODE_BORDER_WIDTH}px`,
          '--question-meta-size': `${NODE_TYPOGRAPHY.body.size * scale}px`,
          '--question-status-size': `${NODE_TYPOGRAPHY.body.size * scale}px`,
          '--question-status-padding-x': `${statusPaddingX}px`,
          '--question-icon-slot-width': `${CONVERSATION_CARD_SPACING.iconSlotWidth * scale}px`,
          '--question-icon-gap': `${CONVERSATION_CARD_SPACING.rowGap * scale}px`,
          '--question-meta-line': NODE_TYPOGRAPHY.body.lineHeight,
          '--question-title-line': NODE_TYPOGRAPHY.cardTitle.lineHeight,
          '--question-title-weight': QUESTION_NODE_TITLE_WEIGHT,
          '--question-header-height': `${QUESTION_NODE_HEADER_HEIGHT * scale}px`,
          '--question-header-gap': `${QUESTION_NODE_HEADER_GAP * scale}px`,
        } as CSSProperties
      }
    >
      <div className="question-conversation-main">
        <Tooltip content={agent.alias} wrapperClassName="inline-flex shrink-0">
          <span
            className="question-conversation-agent"
            aria-label={agent.alias}
          >
            <AgentAvatarMark
              agent={agent}
              size={CONVERSATION_CARD_SPACING.agentSize * scale}
              detail="full"
            />
          </span>
        </Tooltip>
        <div
          className="question-conversation-question"
          data-placeholder={!text || undefined}
          style={{ fontSize: effectiveFontSize }}
        >
          <CardTitle
            title={text || placeholder}
            selected={selected}
            renameLabel={t('node.rename')}
            editor={titleEditor}
          />
        </div>
      </div>
      {titleEditor?.error ? (
        <div
          role="alert"
          className="text-danger-fg"
          style={{ fontSize: NODE_TYPOGRAPHY.body.size * scale }}
        >
          {titleEditor.error}
        </div>
      ) : null}
      <div className="question-conversation-header">
        <span
          className="question-conversation-status"
          title={description}
          aria-label={description}
        >
          <Icon
            size={statusIconSize}
            aria-hidden
            className={
              state === 'running' ? 'question-conversation-loading' : undefined
            }
          />
          <span>{label}</span>
        </span>
        <NodeActivityTime
          updatedAt={lastActivityAt}
          kind="conversation"
          scale={scale}
        />
      </div>
    </div>
  );
}
