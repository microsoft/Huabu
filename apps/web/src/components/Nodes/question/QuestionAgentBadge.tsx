import { useStore } from '@xyflow/react';
import { clsx } from 'clsx';
import { AlertTriangle, ShieldQuestion } from 'lucide-react';

import './QuestionAgentBadge.css';

import { AgentIcon } from '@/components/Common/AgentIcon.tsx';
import { BuiltInAgentAvatar } from '@/components/Common/BuiltInAgentAvatar.tsx';
import { Button } from '@/components/Common/Button.tsx';
import { Tooltip } from '@/components/Common/Tooltip.tsx';

import { QuestionAgentBubble } from './QuestionAgentBubble.tsx';
import { resolveQuestionBadgeChrome } from './questionBadgeChrome.ts';

import type { QuestionAgentPresentation } from '@/utils/questionAgentPresentation.ts';
import type { CSSProperties, ReactNode } from 'react';

export type QuestionAgentBadgeStatus =
  | 'open'
  | 'running'
  | 'approval'
  | 'done'
  | 'error';

export interface QuestionAgentBadgeProps {
  status: QuestionAgentBadgeStatus;
  agent: QuestionAgentPresentation;
  unread: boolean;
  conflictCount: number;
  conflictTooltip?: string;
  offset: { top: number; left: number };
  tooltip?: ReactNode;
  onClick?: () => void;
}

export function QuestionAgentBadge({
  status,
  agent,
  unread,
  conflictCount,
  conflictTooltip,
  offset,
  tooltip,
  onClick,
}: QuestionAgentBadgeProps) {
  const zoom = useStore((state) => state.transform[2]);
  const inverseZoom = zoom > 0 ? 1 / zoom : 1;
  const {
    isOpen,
    isRunning,
    isApproval,
    isError,
    hasConflict,
    needsAttention,
    runningRingColor,
    ringBorderColor,
    ringBoxShadow,
    stickerFill,
  } = resolveQuestionBadgeChrome({ status, agent, unread, conflictCount });
  const stateLabel = isApproval
    ? 'Approval required'
    : isOpen
      ? 'Open for question'
      : isRunning
        ? 'Running'
        : `${isError ? 'Error' : hasConflict ? 'Done · conflicts' : 'Done'}${
            unread ? ' · unread' : ' · viewed'
          }`;

  const badgeStyle: CSSProperties = {
    background: isOpen ? 'transparent' : stickerFill,
    borderColor: ringBorderColor,
    boxShadow: ringBoxShadow,
    ['--question-agent-running-ring' as string]: runningRingColor,
  };

  const badge = (
    <Button
      variant="ghost"
      shape="pill"
      size="sm"
      aria-label={`${agent.alias} · ${stateLabel}`}
      onClick={onClick}
      disabled={!onClick}
      className={clsx(
        'question-agent-badge relative p-0 disabled:cursor-default disabled:opacity-100',
        // The ghost Button variant sets `border-none` (border-style: none),
        // which would suppress the quiet/attention ring even with border-2, so
        // force `border-solid` back on.
        'border-2 border-solid shadow-sm',
        isOpen && 'border-transparent shadow-none',
        isRunning &&
          'question-agent-ring-running border-transparent shadow-none',
        isApproval && 'question-agent-ring-approval border-transparent',
        isError &&
          needsAttention &&
          'question-agent-ring-error border-transparent',
        needsAttention && !isApproval && 'question-agent-attention',
      )}
      style={badgeStyle}
    >
      {isOpen ? (
        <QuestionAgentBubble
          fill={stickerFill}
          className="question-agent-badge-bubble pointer-events-none absolute -top-0.5 -left-0.5"
        />
      ) : null}
      {agent.kind === 'internal' ? (
        <BuiltInAgentAvatar
          mode={agent.mode}
          size={29}
          motion={isRunning ? 'working' : 'none'}
          className={clsx(
            'question-agent-badge-icon relative z-10',
            isOpen && 'translate-x-0.5 translate-y-0.5',
          )}
        />
      ) : (
        <AgentIcon
          shape={agent.icon.shape}
          color={agent.icon.color}
          size={29}
          withFace
          motion={isRunning ? 'working' : 'none'}
          className={clsx(
            'question-agent-badge-icon relative z-10',
            isOpen && 'translate-x-0.5 translate-y-0.5',
          )}
        />
      )}
      {hasConflict ? (
        <span
          title={conflictTooltip}
          className="bg-warning-bg text-warning absolute -top-2.5 -right-3.5 z-20 flex h-6 min-w-6 items-center justify-center gap-0.5 rounded-full px-1.5 text-[11px] font-bold shadow-sm"
        >
          <AlertTriangle size={12} />
          {conflictCount}
        </span>
      ) : null}
      {isApproval ? (
        <span className="bg-warning text-fg-inverse absolute -top-1.5 -right-1.5 z-20 flex size-4 items-center justify-center rounded-full shadow-sm">
          <ShieldQuestion size={10} />
        </span>
      ) : null}
    </Button>
  );

  return (
    <div
      className="pointer-events-none absolute z-10"
      style={{
        top: offset.top * inverseZoom,
        left: offset.left * inverseZoom,
        transform: `scale(${inverseZoom})`,
        transformOrigin: 'top left',
      }}
    >
      <div
        className={onClick ? 'question-agent-badge-hit' : 'pointer-events-none'}
      >
        {tooltip ? <Tooltip content={tooltip}>{badge}</Tooltip> : badge}
      </div>
    </div>
  );
}
