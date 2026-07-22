import { useStore } from '@xyflow/react';
import { clsx } from 'clsx';
import { AlertTriangle } from 'lucide-react';

import './QuestionAgentBadge.css';

import {
  AgentIcon,
  agentIconColorHex,
} from '@/components/Common/AgentIcon.tsx';
import { BuiltInAgentAvatar } from '@/components/Common/BuiltInAgentAvatar.tsx';
import { Button } from '@/components/Common/Button.tsx';
import { Tooltip } from '@/components/Common/Tooltip.tsx';

import type { QuestionAgentPresentation } from '@/utils/questionAgentPresentation.ts';
import type { CSSProperties, ReactNode } from 'react';

export type QuestionAgentBadgeStatus = 'open' | 'running' | 'done' | 'error';

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
  const isOpen = status === 'open';
  const isRunning = status === 'running';
  const isError = status === 'error';
  const hasConflict = conflictCount > 0;
  // Any unviewed terminal outcome wants attention: a done-unread answer, an
  // (unviewed) error, or skipped-write conflicts.
  const needsAttention = unread || hasConflict;
  const attentionColor = isError
    ? 'var(--danger)'
    : hasConflict
      ? 'var(--warning)'
      : 'var(--success)';
  const stateLabel = isOpen
    ? 'Open for question'
    : isRunning
      ? 'Running'
      : `${isError ? 'Error' : hasConflict ? 'Done · conflicts' : 'Done'}${
          unread ? ' · unread' : ' · viewed'
        }`;

  // Running echoes the agent's own identity colour (external picked colour /
  // built-in Huabu blue) so the sweeping ring reads as "this agent is working"
  // rather than a generic system blue.
  const runningRingColor =
    agent.kind === 'external' ? agentIconColorHex(agent.icon.color) : '#00A4EF';

  // Border + halo. `open` / `running` draw no halo (running uses its `::before`
  // sweep). The three unviewed outcomes (done-unread, error, conflict) share
  // ONE attention halo — a crisp inner ring + a wider outer glow — differing
  // only by colour and, for error, the segmented `::before` ring geometry.
  // A viewed answer (or viewed error) falls back to the quiet identity ring.
  let ringBorderColor = 'var(--question-agent-quiet-ring)';
  let ringBoxShadow = 'none';
  if (isOpen || isRunning) {
    ringBorderColor = 'transparent';
  } else if (needsAttention) {
    ringBoxShadow = `0 0 0 3px color-mix(in srgb, ${attentionColor} 26%, transparent), 0 0 12px 2px color-mix(in srgb, ${attentionColor} 42%, transparent)`;
    ringBorderColor = isError ? 'transparent' : attentionColor;
  }

  const badgeStyle: CSSProperties = {
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
        'question-agent-badge relative h-8 w-8 p-0 disabled:cursor-default disabled:opacity-100',
        'bg-surface enabled:hover:bg-surface border-2 shadow-sm',
        isOpen && 'border-transparent bg-transparent shadow-none',
        isRunning &&
          'question-agent-ring-running border-transparent shadow-none',
        isError &&
          needsAttention &&
          'question-agent-ring-error border-transparent',
        needsAttention && 'question-agent-attention',
      )}
      style={badgeStyle}
    >
      {isOpen ? (
        <svg
          className="question-agent-badge-bubble pointer-events-none absolute -top-0.5 -left-0.5 overflow-visible"
          viewBox="0 0 44 48"
          aria-hidden
        >
          <path
            d="M22 2C11 2 2 11 2 22c0 8 4.5 14.5 11 18l-4 6 9-4.5c1.3.3 2.6.5 4 .5 11 0 20-9 20-20S33 2 22 2Z"
            fill="var(--bg-surface)"
            stroke="var(--question-border)"
            strokeWidth="2"
            strokeLinejoin="round"
          />
        </svg>
      ) : null}
      {agent.kind === 'internal' ? (
        <BuiltInAgentAvatar
          mode={agent.mode}
          size={26}
          motion={isRunning ? 'working' : 'none'}
          className="question-agent-badge-icon relative z-10"
        />
      ) : (
        <AgentIcon
          shape={agent.icon.shape}
          color={agent.icon.color}
          size={26}
          withFace
          motion={isRunning ? 'working' : 'none'}
          className="question-agent-badge-icon relative z-10"
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
