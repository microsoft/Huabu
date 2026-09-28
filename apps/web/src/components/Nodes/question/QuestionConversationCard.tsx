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
import {
  QUESTION_FONT_FAMILY,
  QUESTION_NODE_HEADER_HEIGHT,
  QUESTION_NODE_HEADER_GAP,
  QUESTION_NODE_HEADER_INSET,
  QUESTION_NODE_STATUS_SIZE,
  QUESTION_NODE_TITLE_WEIGHT,
} from '@/utils/node/nodeFontConfig';

import { resolveQuestionTakeoverTone } from './QuestionTakeoverMark';
import { useQuestionHeaderFit } from './useQuestionHeaderFit';
import { NODE_TYPOGRAPHY } from '../design/nodeTypography';
import { resolveTextBodyBox } from '../shared/TextNodeBody';

import type { QuestionAgentBadgeStatus } from './questionBadgeChrome';
import type { TextNodeBodyProps } from '../shared/TextNodeBody';
import type { QuestionAgentPresentation } from '@/utils/questionAgentPresentation';
import type { CSSProperties } from 'react';

export function resolveQuestionCardState(
  status: QuestionAgentBadgeStatus | 'idle',
  unread: boolean,
  conflictCount: number,
) {
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
  text,
  placeholder,
  effectiveWidth,
  effectiveHeight,
  effectiveFontSize,
  paddingX,
  paddingY,
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
  text: string;
  placeholder: string;
}) {
  const { t } = useTranslation();
  const scale = effectiveFontSize / NODE_TYPOGRAPHY.cardTitle.size;
  const state = resolveQuestionCardState(status, unread, conflictCount);
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
  const { fit, headerRef, aliasRef, labelRef } = useQuestionHeaderFit(
    QUESTION_NODE_HEADER_HEIGHT * scale,
    8 * scale,
    QUESTION_NODE_STATUS_SIZE * scale,
    agent.alias,
    label,
  );
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
      data-compact={!fit.alias || undefined}
      style={
        {
          // Bleed over the shared transparent shell inset without changing its
          // interaction geometry. The full authored card scales down to 10%.
          width: box.width + NODE_SHELL_INSET,
          height: box.height,
          margin: -NODE_SHELL_INSET / 2,
          padding: `${box.paddingY - QUESTION_NODE_HEADER_INSET * scale}px ${paddingX}px`,
          fontFamily: QUESTION_FONT_FAMILY,
          '--question-scale': scale,
          '--question-meta-size': `${NODE_TYPOGRAPHY.body.size * scale}px`,
          '--question-status-size': `${NODE_TYPOGRAPHY.body.size * scale}px`,
          '--question-meta-line': NODE_TYPOGRAPHY.body.lineHeight,
          '--question-title-line': NODE_TYPOGRAPHY.cardTitle.lineHeight,
          '--question-title-weight': QUESTION_NODE_TITLE_WEIGHT,
          '--question-header-height': `${QUESTION_NODE_HEADER_HEIGHT * scale}px`,
          '--question-header-gap': `${QUESTION_NODE_HEADER_GAP * scale}px`,
        } as CSSProperties
      }
    >
      <div className="question-conversation-header" ref={headerRef}>
        <span className="question-conversation-agent" title={agent.alias}>
          <AgentAvatarMark
            agent={agent}
            size={QUESTION_NODE_HEADER_HEIGHT * scale}
            detail="full"
          />
          <span>{agent.alias}</span>
        </span>
        <span
          className="question-conversation-status"
          title={description}
          aria-label={description}
          style={{ display: fit.status ? undefined : 'none' }}
        >
          <Icon
            size={QUESTION_NODE_STATUS_SIZE * scale}
            aria-hidden
            className={
              state === 'running' ? 'question-conversation-loading' : undefined
            }
          />
          <span style={{ display: fit.statusText ? undefined : 'none' }}>
            {label}
          </span>
        </span>
      </div>
      <span
        className="question-conversation-fit-probe"
        ref={aliasRef}
        aria-hidden
      >
        {agent.alias}
      </span>
      <span
        className="question-conversation-fit-probe"
        ref={labelRef}
        aria-hidden
      >
        {label}
      </span>
      <div
        className="question-conversation-question"
        data-placeholder={!text || undefined}
        style={{ fontSize: effectiveFontSize }}
      >
        {text || placeholder}
      </div>
    </div>
  );
}
