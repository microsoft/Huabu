// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { clsx } from 'clsx';
import { ShieldQuestion } from 'lucide-react';
import { useLayoutEffect } from 'react';

import './QuestionAgentBadge.css';

import { AgentAvatarMark } from '@/components/Common/AgentAvatarMark';
import { Tooltip } from '@/components/Common/Tooltip';
import {
  QUESTION_TAKEOVER_AVATAR_RATIO,
  QUESTION_TAKEOVER_SIZE,
} from '@/config/nodeTakeover';

import { QuestionAgentBubble } from './QuestionAgentBubble';
import { resolveQuestionBadgeChrome } from './questionBadgeChrome';

import type { QuestionAgentBadgeStatus } from './questionBadgeChrome';
import type { TakeoverState } from '@/config/nodeTakeover';
import type { QuestionAgentPresentation } from '@/utils/questionAgentPresentation';
import type { CSSProperties, ReactNode } from 'react';

export interface QuestionTakeoverMarkProps {
  state: TakeoverState;
  presentation?: 'avatar' | 'dot';
  status: QuestionAgentBadgeStatus | 'idle';
  /** Independent of lifecycle; legacy status="open" remains supported. */
  isOpen?: boolean;
  agent: QuestionAgentPresentation;
  unread: boolean;
  conflictCount: number;
  interactive: boolean;
  onOpen?: () => void;
  accessibleLabel?: string;
  tooltip?: ReactNode;
  conflictTooltip?: string;
}

/** No screen-space floors: this geometry is authored once, then scaled. */
export function resolveQuestionSpecialRingGeometry(size: number) {
  return { inset: size / 18, width: size / 12 };
}

export function resolveQuestionTakeoverTone(
  status: QuestionTakeoverMarkProps['status'],
  unread: boolean,
  conflictCount: number,
) {
  if (status === 'approval') return 'warning';
  if (status === 'running') return 'info';
  if (status === 'error') return 'danger';
  if (status === 'done' && conflictCount > 0) return 'warning';
  if (status === 'done' && unread) return 'success';
  return 'neutral';
}

const AVATAR = QUESTION_TAKEOVER_SIZE * QUESTION_TAKEOVER_AVATAR_RATIO;

/** Visible bounding square, excluding transparent space in the authored footprint. */
export function questionTakeoverMarkLayout(
  specialRing: boolean,
  approval: boolean,
  open: boolean,
) {
  const ring = resolveQuestionSpecialRingGeometry(AVATAR);
  if (open) {
    // Include the shared SVG's 2-unit rounded stroke and approval satellite.
    // The square encloses the painted body/tail, not its transparent viewBox.
    const unit = (AVATAR * 1.3) / 48;
    const avatarTop = 21 * unit - AVATAR / 2;
    const extra = approval ? Math.max(0, AVATAR * 0.45 * 0.3 - avatarTop) : 0;
    return {
      diameter: 46 * unit + 2 * extra,
      avatarLeft: 23 * unit - AVATAR / 2 + extra,
      avatarTop: avatarTop + extra,
      bubbleUnit: unit,
      bubbleLeft: unit + extra,
      bubbleTop: -unit + extra,
    };
  }
  const inset = specialRing ? ring.inset : 0;
  const satelliteOverhang = approval ? AVATAR * 0.45 * 0.3 : 0;
  const extra = Math.max(inset, satelliteOverhang);
  return {
    diameter: AVATAR + inset + extra,
    avatarLeft: inset,
    avatarTop: extra,
    bubbleUnit: 0,
    bubbleLeft: 0,
    bubbleTop: 0,
  };
}

/** D's complete avatar and state chrome in authored coordinates at every zoom. */
export function QuestionTakeoverMark({
  state,
  presentation = 'avatar',
  status,
  isOpen = status === 'open',
  agent,
  unread,
  conflictCount,
  interactive,
  onOpen,
  accessibleLabel,
  tooltip,
  conflictTooltip,
}: QuestionTakeoverMarkProps) {
  const chip = resolveQuestionBadgeChrome({
    status,
    agent,
    unread,
    conflictCount,
  });
  const tone = resolveQuestionTakeoverTone(status, unread, conflictCount);
  const special =
    chip.isRunning || chip.isApproval || (chip.isError && chip.needsAttention);
  const isDot = presentation === 'dot';
  const layout = questionTakeoverMarkLayout(
    !isDot && special,
    !isDot && chip.isApproval,
    !isDot && isOpen,
  );
  const ratio = layout.diameter / QUESTION_TAKEOVER_SIZE;
  const { onBoundsChange } = state;
  useLayoutEffect(() => {
    onBoundsChange?.(ratio);
  }, [onBoundsChange, ratio]);
  const scale = state.size / QUESTION_TAKEOVER_SIZE;
  const ring = resolveQuestionSpecialRingGeometry(AVATAR);
  const satellite = AVATAR * 0.45;
  const canOpen = interactive && !!onOpen;
  const neutral = tone === 'neutral';
  const fill = `var(--${neutral ? 'bg-hover' : `${tone}-bg`})`;
  const border = `var(--${neutral ? 'fg-subtle' : `${tone}-light`})`;
  const ringColor =
    status === 'idle'
      ? 'transparent'
      : chip.needsAttention
        ? chip.attentionColor
        : 'var(--edge-default)';
  const mark = (
    <div
      data-question-takeover-mark
      data-state={status}
      data-open={isOpen}
      data-tone={tone}
      role="button"
      tabIndex={canOpen ? 0 : undefined}
      aria-label={canOpen ? (accessibleLabel ?? agent.alias) : undefined}
      aria-hidden={!canOpen || undefined}
      style={{
        position: 'relative',
        width: layout.diameter * scale,
        height: layout.diameter * scale,
        cursor: canOpen ? 'pointer' : 'default',
      }}
      onClick={
        canOpen
          ? (event) => {
              event.stopPropagation();
              onOpen();
            }
          : undefined
      }
      onKeyDown={
        canOpen
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                event.stopPropagation();
                onOpen();
              }
            }
          : undefined
      }
    >
      {isDot ? (
        <div
          data-question-takeover-dot
          className="bg-surface dark:bg-inverse pointer-events-none h-full w-full rounded-full"
        />
      ) : (
        <div
          style={{
            position: 'absolute',
            width: layout.diameter,
            height: layout.diameter,
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
            pointerEvents: 'none',
          }}
        >
          {isOpen && (
            <QuestionAgentBubble
              fill={fill}
              className="question-agent-badge-bubble"
              style={
                {
                  position: 'absolute',
                  left: layout.bubbleLeft,
                  top: layout.bubbleTop,
                  width: layout.bubbleUnit * 44,
                  height: layout.bubbleUnit * 48,
                  '--question-border': border,
                } as CSSProperties
              }
            />
          )}
          <div
            className={clsx(
              'relative rounded-full',
              !isOpen && chip.isRunning && 'question-agent-ring-running',
              !isOpen && chip.isApproval && 'question-agent-ring-approval',
              !isOpen &&
                chip.isError &&
                chip.needsAttention &&
                'question-agent-ring-error',
            )}
            data-question-takeover-avatar
            style={
              {
                position: 'absolute',
                left: layout.avatarLeft,
                top: layout.avatarTop,
                width: AVATAR,
                height: AVATAR,
                background: isOpen ? 'transparent' : 'var(--bg-surface)',
                boxShadow:
                  isOpen || special ? 'none' : `inset 0 0 0 1px ${ringColor}`,
                '--question-agent-running-ring': 'var(--info)',
                '--question-agent-special-ring-inset': `${ring.inset}px`,
                '--question-agent-special-ring-width': `${ring.width}px`,
              } as CSSProperties
            }
          >
            <AgentAvatarMark
              agent={agent}
              size={AVATAR}
              detail="full"
              motion={chip.isRunning ? 'working' : 'none'}
              className="relative"
            />
            {chip.isApproval && (
              <span
                title={conflictTooltip}
                className="bg-warning text-fg-inverse absolute z-20 flex items-center justify-center rounded-full"
                style={{
                  width: satellite,
                  height: satellite,
                  top: -satellite * 0.3,
                  right: -satellite * 0.3,
                }}
              >
                <ShieldQuestion size={satellite * 0.62} />
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
  return tooltip ? <Tooltip content={tooltip}>{mark}</Tooltip> : mark;
}
