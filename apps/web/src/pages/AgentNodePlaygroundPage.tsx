import { AlertTriangle, Eye, Loader, X } from 'lucide-react';
import { useState } from 'react';

import '@/components/Nodes/question/QuestionAgentBadge.css';

import './AgentNodePlaygroundPage.css';

import {
  AGENT_ICON_COLORS,
  AGENT_ICON_SHAPES,
  AgentIcon,
} from '@/components/Common/AgentIcon';
import { Button } from '@/components/Common/Button';
import { cn } from '@/components/Common/cn';
import {
  AgentModeIcon,
  ChatModeIcon,
} from '@/components/Panels/ChatPanel/ModeIcon';

import type {
  AgentIconColor,
  AgentIconShape,
  AgentIconValue,
} from '@/components/Common/AgentIcon';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * Visual playground for linking Agent Profile avatars to Question Nodes.
 *
 * Route: `/playground/agent-nodes`
 */

type DemoStatus =
  | 'idle'
  | 'running'
  | 'done-unread'
  | 'done-viewed'
  | 'error'
  | 'conflict';

type AgentBadgeStatus = Exclude<DemoStatus, 'idle'> | 'open';
type BuiltInAgentMode = 'ask' | 'operate';
type BuiltInAvatarTreatment =
  | 'refined-line'
  | 'brand-disc'
  | 'soft-bean'
  | 'solid-mark'
  | 'companions'
  | 'mode-characters'
  | 'friendly-marks';
type CandidateShape = 'blob' | 'bean' | 'pebble' | 'wavy-disc' | 'capsule';
type AttentionMotion = 'nudge' | 'slide' | 'lift' | 'pulse' | 'halo' | 'echo';
type StatusRingVariant =
  | 'running-sweep'
  | 'running-orbit'
  | 'running-twin'
  | 'error-break'
  | 'error-brackets'
  | 'error-segments'
  | 'conflict-split'
  | 'conflict-double'
  | 'conflict-crossed';

const SELECTED_ATTENTION_MOTION: AttentionMotion = 'nudge';

const BUILT_IN_STATUS_CASES: Array<{
  status: AgentBadgeStatus;
  label: string;
}> = [
  { status: 'open', label: 'Open' },
  { status: 'running', label: 'Running' },
  { status: 'done-unread', label: 'Done · unread' },
  { status: 'done-viewed', label: 'Done · viewed' },
  { status: 'error', label: 'Error' },
  { status: 'conflict', label: 'Conflict' },
];

const BUILT_IN_AVATAR_TREATMENTS: Array<{
  treatment: BuiltInAvatarTreatment;
  label: string;
  note: string;
  recommended?: boolean;
}> = [
  {
    treatment: 'refined-line',
    label: 'Refined line',
    note: 'The existing mode symbols, optically centered with a lighter stroke.',
  },
  {
    treatment: 'brand-disc',
    label: 'Brand disc',
    note: 'A stable blue identity field makes the modes read as one built-in family.',
  },
  {
    treatment: 'soft-bean',
    label: 'Soft shape',
    note: 'Carries the external Agent avatar language into the first-party modes.',
  },
  {
    treatment: 'solid-mark',
    label: 'Solid mark',
    note: 'Simplified filled symbols hold up at avatar scale with less visual noise.',
  },
  {
    treatment: 'companions',
    label: 'Huabu companions',
    note: 'One friendly built-in character; a bubble or cursor badge identifies the mode.',
  },
  {
    treatment: 'mode-characters',
    label: 'Mode characters',
    note: 'One rounded snowman character: Chat talks with hands on hips; Agent raises a hand, ready to work.',
    recommended: true,
  },
  {
    treatment: 'friendly-marks',
    label: 'Friendly marks',
    note: 'The mode silhouette becomes a face, with no separate toolbar-style glyph.',
  },
];

type StateCase = {
  status: DemoStatus;
  label: string;
  description: string;
  question: string;
  agentName?: string;
  active?: boolean;
};

const STATE_CASES: StateCase[] = [
  {
    status: 'idle',
    label: 'Idle',
    description: 'The question has not started and is not open in Chat.',
    question: 'How should we improve canvas loading time?',
  },
  {
    status: 'idle',
    label: 'Open for question',
    description:
      'A chat bubble anchors the selected agent here, ready for the first send.',
    question: 'Compare the two rendering strategies.',
    agentName: 'Claude Code',
    active: true,
  },
  {
    status: 'running',
    label: 'Running',
    description: 'The avatar owns identity; its semantic ring owns status.',
    question: 'Profile the initial canvas render.',
    agentName: 'GitHub Copilot',
  },
  {
    status: 'done-unread',
    label: 'Done · unread',
    description:
      'A shared attention nudge indicates an unviewed terminal result.',
    question: 'Find unnecessary requests during startup.',
    agentName: 'Codex',
  },
  {
    status: 'done-viewed',
    label: 'Done · viewed',
    description: 'Completed and read returns to a quiet identity marker.',
    question: 'Summarize the performance findings.',
    agentName: 'Gemini CLI',
  },
  {
    status: 'error',
    label: 'Error',
    description: 'The same attention nudge applies; red preserves the outcome.',
    question: 'Apply the selected optimization.',
    agentName: 'Claude Code',
  },
  {
    status: 'conflict',
    label: 'Done · conflicts',
    description:
      'The shared nudge draws attention; the count preserves detail.',
    question: 'Refactor the canvas store without losing local edits.',
    agentName: 'GitHub Copilot',
  },
];

const CANDIDATE_SHAPES: Array<{
  shape: CandidateShape;
  label: string;
  note: string;
}> = [
  {
    shape: 'blob',
    label: 'Rounded blob',
    note: 'The current organic baseline with visible rotation.',
  },
  {
    shape: 'bean',
    label: 'Soft bean',
    note: 'Friendly and asymmetric without feeling directional.',
  },
  {
    shape: 'pebble',
    label: 'Soft pebble',
    note: 'A calmer silhouette with subtle rotational movement.',
  },
  {
    shape: 'wavy-disc',
    label: 'Wavy disc',
    note: 'A near-circle with enough irregularity to show rotation.',
  },
  {
    shape: 'capsule',
    label: 'Rounded capsule',
    note: 'Simple, soft, and clearly animated without sharp points.',
  },
];

const ATTENTION_MOTIONS: Array<{
  motion: AttentionMotion;
  label: string;
  note: string;
}> = [
  {
    motion: 'nudge',
    label: 'Soft nudge',
    note: 'A restrained version of the current side-to-side reminder.',
  },
  {
    motion: 'slide',
    label: 'Side slide',
    note: 'Moves left and right without any tilt or scaling.',
  },
  {
    motion: 'lift',
    label: 'Single lift',
    note: 'Briefly rises and settles, like asking for attention once.',
  },
  {
    motion: 'pulse',
    label: 'Gentle pulse',
    note: 'The whole badge breathes without changing direction.',
  },
  {
    motion: 'halo',
    label: 'Halo breathe',
    note: 'Keeps the badge still and animates only its soft glow.',
  },
  {
    motion: 'echo',
    label: 'Ring echo',
    note: 'A quiet outline travels outward while content stays fixed.',
  },
];

const STATUS_RING_GROUPS: Array<{
  state: 'Running' | 'Error' | 'Conflict';
  description: string;
  candidates: Array<{
    variant: StatusRingVariant;
    label: string;
    note: string;
    recommended?: boolean;
  }>;
}> = [
  {
    state: 'Running',
    description: 'Continuous flow communicates active work without a spinner.',
    candidates: [
      {
        variant: 'running-sweep',
        label: 'Gradient sweep',
        note: 'One soft highlight travels around a quiet information ring.',
        recommended: true,
      },
      {
        variant: 'running-orbit',
        label: 'Segment orbit',
        note: 'Separated marks make progress feel more mechanical and explicit.',
      },
      {
        variant: 'running-twin',
        label: 'Twin current',
        note: 'Two opposing arcs suggest parallel work without adding an icon.',
      },
    ],
  },
  {
    state: 'Error',
    description:
      'A disrupted silhouette remains legible without relying on red.',
    candidates: [
      {
        variant: 'error-break',
        label: 'Broken ring',
        note: 'A single deliberate gap reads as an interrupted run.',
      },
      {
        variant: 'error-brackets',
        label: 'Opposed brackets',
        note: 'Two firm arcs frame the avatar while leaving visible breaks.',
      },
      {
        variant: 'error-segments',
        label: 'Alert segments',
        note: 'Short uneven sections create urgency while remaining still.',
        recommended: true,
      },
    ],
  },
  {
    state: 'Conflict',
    description:
      'Competing contours express two valid versions occupying one place.',
    candidates: [
      {
        variant: 'conflict-split',
        label: 'Split ring',
        note: 'Two separated halves state the conflict with minimal visual weight.',
      },
      {
        variant: 'conflict-double',
        label: 'Offset double',
        note: 'Two misaligned outlines suggest diverging versions.',
      },
      {
        variant: 'conflict-crossed',
        label: 'Crossed arcs',
        note: 'Overlapping contours make the disagreement more pronounced.',
      },
    ],
  },
];

function CandidateShapeBody({ shape }: { shape: CandidateShape }) {
  const fill = 'var(--info)';

  switch (shape) {
    case 'blob':
      return (
        <path
          d="M58 20C73 18 78 32 90 37C103 43 101 58 94 68C88 78 88 93 74 98C62 102 53 91 42 91C28 90 20 79 23 66C26 55 18 43 29 34C39 25 48 23 58 20Z"
          fill={fill}
        />
      );
    case 'bean':
      return (
        <path
          d="M66 19C84 19 99 30 101 45C103 58 94 65 86 70C78 75 82 87 73 95C63 104 45 102 32 92C18 82 15 65 21 50C27 34 42 25 54 21C58 20 62 19 66 19Z"
          fill={fill}
        />
      );
    case 'pebble':
      return (
        <path
          d="M55 19C76 16 94 29 100 48C107 70 94 92 72 100C49 108 26 96 19 74C12 53 24 30 43 22C47 21 51 20 55 19Z"
          fill={fill}
        />
      );
    case 'wavy-disc':
      return (
        <path
          d="M59 18C69 17 74 26 82 29C91 31 100 32 102 41C104 50 97 56 98 65C100 74 103 82 96 89C89 95 80 91 72 97C64 103 56 105 49 99C42 93 41 86 32 83C23 80 16 74 18 65C20 56 28 52 27 43C26 34 30 26 39 23C47 20 52 19 59 18Z"
          fill={fill}
        />
      );
    case 'capsule':
      return (
        <rect
          x="20"
          y="34"
          width="80"
          height="52"
          rx="26"
          fill={fill}
          transform="rotate(-18 60 60)"
        />
      );
  }
}

function CandidateAgentIcon({
  shape,
  running = false,
}: {
  shape: CandidateShape;
  running?: boolean;
}) {
  return (
    <svg
      width="64"
      height="64"
      viewBox="14 14 92 92"
      aria-label={`${shape}${running ? ' running' : ' static'}`}
      role="img"
    >
      <g className={running ? 'agent-icon-working-body' : undefined}>
        <CandidateShapeBody shape={shape} />
      </g>
      <g
        fill="none"
        stroke="var(--fg-default)"
        strokeWidth="4.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M50 50L49 58" />
        <path d="M70 50L69 58" />
        <path d="M54 69C58 73 64 74 68 70" />
      </g>
    </svg>
  );
}

function AttentionMotionCandidate({
  motion,
  icon,
}: {
  motion: AttentionMotion;
  icon: AgentIconValue;
}) {
  return (
    <div className="flex h-24 items-center justify-center">
      <div
        className={cn(
          'question-attention-candidate bg-surface border-success relative flex size-12 items-center justify-center rounded-full border-2',
          `question-attention-candidate-${motion}`,
        )}
        aria-label={`${motion} unread motion`}
      >
        <AgentIcon shape={icon.shape} color={icon.color} size={36} withFace />
      </div>
    </div>
  );
}

function StatusRingCandidate({
  variant,
  icon,
}: {
  variant: StatusRingVariant;
  icon: AgentIconValue;
}) {
  const isRunning = variant.startsWith('running-');

  return (
    <div className="flex h-24 items-center justify-center">
      <div
        className={cn(
          'status-ring-candidate',
          `status-ring-candidate-${variant}`,
        )}
        aria-label={`${variant} ring candidate`}
      >
        <div className="status-ring-candidate-core">
          <AgentIcon
            shape={icon.shape}
            color={icon.color}
            size={38}
            withFace
            motion={isRunning ? 'working' : 'none'}
          />
        </div>
      </div>
    </div>
  );
}

const STATUS_META: Record<
  AgentBadgeStatus,
  {
    color: string;
    title: string;
    ringStyle: 'solid' | 'dashed';
    quiet?: boolean;
    chatBubble?: boolean;
  }
> = {
  open: {
    color: 'var(--question-border)',
    title: 'Open in Chat · Not started',
    ringStyle: 'solid',
    chatBubble: true,
  },
  running: {
    color: 'var(--info)',
    title: 'Running',
    ringStyle: 'solid',
  },
  'done-unread': {
    color: 'var(--success)',
    title: 'Done · Unread',
    ringStyle: 'solid',
  },
  'done-viewed': {
    color: 'var(--question-agent-quiet-ring)',
    title: 'Done · Viewed',
    ringStyle: 'solid',
    quiet: true,
  },
  error: {
    color: 'var(--danger)',
    title: 'Error',
    ringStyle: 'solid',
  },
  conflict: {
    color: 'var(--warning)',
    title: 'Done · Conflicts',
    ringStyle: 'solid',
  },
};

function AgentRunBadge({
  icon,
  status,
  agentName,
  expanded,
}: {
  icon: AgentIconValue;
  status: AgentBadgeStatus;
  agentName: string;
  expanded: boolean;
}) {
  const meta = STATUS_META[status];
  const isRunning = status === 'running';
  const isUnread = status === 'done-unread';
  const isError = status === 'error';
  const hasConflict = status === 'conflict';
  const needsAttention = isUnread || isError || hasConflict;
  const usesCustomRing = isRunning || isError;
  const usesIntegratedChatBubble = meta.chatBubble === true;
  const containerAnimation = needsAttention
    ? `playground-question-attention-${SELECTED_ATTENTION_MOTION} 4s ease-in-out infinite`
    : undefined;

  return (
    <div
      className={cn(
        'question-agent-badge relative inline-flex h-10 items-center rounded-full border-2',
        expanded ? 'w-36 gap-1.5 pr-3 pl-1' : 'w-10 justify-center',
        usesIntegratedChatBubble ? 'bg-transparent' : 'bg-surface shadow-sm',
        isRunning && 'question-agent-ring-running',
        isError && 'question-agent-ring-error',
      )}
      style={{
        borderColor:
          usesIntegratedChatBubble || usesCustomRing
            ? 'transparent'
            : meta.color,
        borderStyle: meta.ringStyle,
        boxShadow:
          meta.quiet || usesIntegratedChatBubble || isRunning
            ? 'none'
            : isError
              ? `0 0 9px color-mix(in srgb, ${meta.color} 30%, transparent)`
              : needsAttention
                ? `0 0 0 3px color-mix(in srgb, ${meta.color} 25%, transparent), 0 2px 9px color-mix(in srgb, ${meta.color} 32%, transparent)`
                : `0 2px 9px color-mix(in srgb, ${meta.color} 32%, transparent)`,
        animation: containerAnimation,
      }}
      title={`${agentName} · ${meta.title}`}
      aria-label={`${agentName} · ${meta.title}`}
    >
      {usesIntegratedChatBubble ? (
        <svg
          className={cn(
            'pointer-events-none absolute -top-0.5 -left-0.5 h-12 overflow-visible',
            expanded ? 'w-[148px]' : 'w-11',
          )}
          viewBox={expanded ? '0 0 148 48' : '0 0 44 48'}
          aria-hidden
        >
          <path
            d={
              expanded
                ? 'M22 2h104c11 0 20 9 20 20s-9 20-20 20H22c-1.4 0-2.7-.2-4-.5L9 46l4-6C6.5 36.5 2 30 2 22 2 11 11 2 22 2Z'
                : 'M22 2C11 2 2 11 2 22c0 8 4.5 14.5 11 18l-4 6 9-4.5c1.3.3 2.6.5 4 .5 11 0 20-9 20-20S33 2 22 2Z'
            }
            fill="var(--bg-surface)"
            stroke={meta.color}
            strokeWidth="2"
            strokeLinejoin="round"
          />
        </svg>
      ) : null}
      <AgentIcon
        shape={icon.shape}
        color={icon.color}
        size={32}
        withFace
        motion={isRunning ? 'working' : 'none'}
        className={cn(
          'question-agent-badge-icon relative z-10',
          usesIntegratedChatBubble && 'translate-x-0.5',
          usesIntegratedChatBubble && 'translate-y-0.5',
        )}
      />
      {expanded ? (
        <span className="text-fg-default relative z-10 max-w-28 truncate text-xs font-semibold">
          {agentName}
        </span>
      ) : null}
      {hasConflict ? (
        <span className="bg-warning-bg text-warning absolute -top-2.5 -right-3.5 z-20 flex h-6 min-w-6 items-center justify-center gap-0.5 rounded-full px-1.5 text-[11px] font-bold shadow-sm">
          <AlertTriangle size={12} />2
        </span>
      ) : null}
    </div>
  );
}

function BuiltInAgentStateBadge({
  mode,
  status,
}: {
  mode: BuiltInAgentMode;
  status: AgentBadgeStatus;
}) {
  const meta = STATUS_META[status];
  const isOpen = status === 'open';
  const isRunning = status === 'running';
  const isError = status === 'error';
  const hasConflict = status === 'conflict';
  const needsAttention = status === 'done-unread' || isError || hasConflict;
  const usesCustomRing = isRunning || isError;
  const modeLabel = mode === 'operate' ? 'Agent' : 'Chat';

  return (
    <div
      className={cn(
        'question-agent-badge text-fg-default bg-surface relative inline-flex h-10 w-10 items-center justify-center rounded-full border-2 shadow-sm',
        isOpen && 'border-transparent bg-transparent shadow-none',
        isRunning &&
          'question-agent-ring-running border-transparent shadow-none',
        isError && 'question-agent-ring-error border-transparent',
        needsAttention && 'question-agent-attention',
      )}
      style={{
        borderColor: isOpen || usesCustomRing ? 'transparent' : meta.color,
        boxShadow:
          isOpen || isRunning || meta.quiet
            ? 'none'
            : isError
              ? `0 0 9px color-mix(in srgb, ${meta.color} 30%, transparent)`
              : needsAttention
                ? `0 0 0 3px color-mix(in srgb, ${meta.color} 25%, transparent), 0 2px 9px color-mix(in srgb, ${meta.color} 32%, transparent)`
                : 'none',
      }}
      title={`${modeLabel} · ${meta.title}`}
      aria-label={`${modeLabel} · ${meta.title}`}
    >
      {isOpen ? (
        <svg
          className="pointer-events-none absolute -top-1 -left-1 h-12 w-12 overflow-visible"
          viewBox="0 0 48 48"
          aria-hidden
        >
          <path
            d="M24 2C12 2 2 11 2 22c0 8 5 15 12 18l-4 6 9-4c2 .3 3 .5 5 .5 12 0 22-9 22-20S36 2 24 2Z"
            fill="var(--bg-surface)"
            stroke="var(--question-border)"
            strokeWidth="2"
            strokeLinejoin="round"
          />
        </svg>
      ) : null}
      <div className="relative z-10 h-8 w-8">
        <BuiltInCharacterAvatar
          mode={mode}
          treatment="mode-characters"
          size={32}
        />
      </div>
      {hasConflict ? (
        <span className="bg-warning-bg text-warning absolute -top-2.5 -right-3.5 z-20 flex h-6 min-w-6 items-center justify-center gap-0.5 rounded-full px-1.5 text-[11px] font-bold shadow-sm">
          <AlertTriangle size={12} />2
        </span>
      ) : null}
    </div>
  );
}

function BuiltInSolidMark({
  mode,
  size = 22,
  className,
}: {
  mode: BuiltInAgentMode;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      aria-hidden
    >
      {mode === 'ask' ? (
        <>
          <path
            d="M6 7.5h20a3.5 3.5 0 0 1 3.5 3.5v9A3.5 3.5 0 0 1 26 23.5h-9l-6.5 5v-5H6A3.5 3.5 0 0 1 2.5 20v-9A3.5 3.5 0 0 1 6 7.5Z"
            fill="currentColor"
          />
          <g fill="var(--bg-surface)">
            <circle cx="10" cy="15.5" r="1.5" />
            <circle cx="16" cy="15.5" r="1.5" />
            <circle cx="22" cy="15.5" r="1.5" />
          </g>
        </>
      ) : (
        <>
          <rect x="3" y="5" width="17" height="14" rx="3" fill="currentColor" />
          <path
            d="M15.5 15.5v14l4-4 3.2 6 4-2.1-3.2-5.8H30l-14.5-8.1Z"
            fill="currentColor"
            stroke="var(--bg-surface)"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        </>
      )}
    </svg>
  );
}

function BuiltInCharacterAvatar({
  mode,
  treatment,
  size = 40,
}: {
  mode: BuiltInAgentMode;
  treatment: 'companions' | 'mode-characters' | 'friendly-marks';
  size?: number;
}) {
  const isOperate = mode === 'operate';
  const face = (
    <g
      fill="none"
      stroke="#24221E"
      strokeWidth="3.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M42 49v6" />
      <path d="M62 49v6" />
      <path d="M45 65c4 4 10 4 14 0" />
    </g>
  );

  if (treatment === 'companions') {
    return (
      <svg width={size} height={size} viewBox="12 12 80 80" aria-hidden>
        <path
          d="M55 18c18 0 31 10 33 25 2 13-7 20-15 25-8 5-5 14-14 19-11 6-28 1-36-11-9-13-6-31 6-43 7-8 17-15 26-15Z"
          fill="#FFB900"
        />
        {face}
        <g transform="translate(64 63)">
          <circle cx="12" cy="12" r="13" fill="var(--bg-surface)" />
          <circle
            cx="12"
            cy="12"
            r="11"
            fill={isOperate ? 'var(--success)' : 'var(--info)'}
          />
          {isOperate ? (
            <path
              d="M8 6v13l3.5-3.5 2.8 5.2 3-1.6-2.7-5H20L8 6Z"
              fill="var(--fg-inverse)"
              stroke="var(--fg-inverse)"
              strokeWidth="1.2"
              strokeLinejoin="round"
            />
          ) : (
            <path
              d="M6 7.5h12v8H12l-3.5 3v-3H6v-8Z"
              fill="none"
              stroke="var(--fg-inverse)"
              strokeWidth="2"
              strokeLinejoin="round"
            />
          )}
        </g>
      </svg>
    );
  }

  if (treatment === 'mode-characters') {
    const characterColor = isOperate ? '#7FBA00' : '#00A4EF';

    return (
      <svg width={size} height={size} viewBox="12 12 80 80" aria-hidden>
        {isOperate ? (
          <g
            fill="none"
            stroke="#24221E"
            strokeWidth="3.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M71 64c9-3 14-10 16-19" />
            <path d="M28 67c-4 3-6 7-6 12" />
          </g>
        ) : null}
        <ellipse cx="50" cy="72" rx="28" ry="21" fill={characterColor} />
        <ellipse cx="50" cy="39" rx="24" ry="22" fill={characterColor} />
        {isOperate ? (
          <g stroke="#24221E" strokeWidth="3.2" strokeLinecap="round">
            <circle cx="87" cy="45" r="2.6" fill="#24221E" stroke="none" />
            <path d="M88 44L92 39" fill="none" />
          </g>
        ) : null}
        <g
          fill="none"
          stroke="#24221E"
          strokeWidth="3.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M40 35v5" />
          <path d="M60 35v5" />
          {isOperate ? (
            <path d="M42 48c5 4 11 4 16 0" />
          ) : (
            <ellipse
              cx="51"
              cy="49"
              rx="5.5"
              ry="3.6"
              fill="var(--bg-surface)"
              transform="rotate(18 51 49)"
            />
          )}
        </g>
      </svg>
    );
  }

  return (
    <svg width={size} height={size} viewBox="12 12 80 80" aria-hidden>
      {isOperate ? (
        <path
          d="M19 22h45a13 13 0 0 1 13 13v24a13 13 0 0 1-13 13H32a13 13 0 0 1-13-13V22Z"
          fill="#7FBA00"
        />
      ) : (
        <path
          d="M25 20h50a13 13 0 0 1 13 13v31a13 13 0 0 1-13 13H52L34 89V77h-9a13 13 0 0 1-13-13V33a13 13 0 0 1 13-13Z"
          fill="#00A4EF"
        />
      )}
      {face}
      {isOperate ? (
        <path
          d="M62 59v29l7-7 5.5 10 7-3.5-5.5-10h11L62 59Z"
          fill="var(--bg-surface)"
          stroke="#24221E"
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
      ) : null}
    </svg>
  );
}

function BuiltInAvatarCandidate({
  mode,
  treatment,
}: {
  mode: BuiltInAgentMode;
  treatment: BuiltInAvatarTreatment;
}) {
  const ModeIcon = mode === 'operate' ? AgentModeIcon : ChatModeIcon;

  if (
    treatment === 'companions' ||
    treatment === 'mode-characters' ||
    treatment === 'friendly-marks'
  ) {
    return <BuiltInCharacterAvatar mode={mode} treatment={treatment} />;
  }

  if (treatment === 'refined-line') {
    return (
      <div className="border-edge-default text-fg-default bg-surface flex h-10 w-10 items-center justify-center rounded-full border-2">
        <ModeIcon size={28} strokeWidth={5} />
      </div>
    );
  }

  if (treatment === 'brand-disc') {
    return (
      <div className="bg-info text-fg-inverse flex h-9 w-9 items-center justify-center rounded-full shadow-sm">
        <ModeIcon size={23} strokeWidth={5.5} />
      </div>
    );
  }

  if (treatment === 'soft-bean') {
    return (
      <div className="built-in-avatar-bean bg-info text-fg-inverse flex h-9 w-9 items-center justify-center shadow-sm">
        <ModeIcon size={22} strokeWidth={5.5} />
      </div>
    );
  }

  return (
    <div className="bg-info-bg text-info flex h-9 w-9 items-center justify-center rounded-full">
      <BuiltInSolidMark mode={mode} />
    </div>
  );
}

function BuiltInAgentModeRow({ mode }: { mode: BuiltInAgentMode }) {
  const isOperate = mode === 'operate';

  return (
    <article className="border-edge-default bg-surface rounded-lg border p-4">
      <div className="mb-4 flex items-center gap-2">
        <BuiltInCharacterAvatar
          mode={mode}
          treatment="mode-characters"
          size={24}
        />
        <div>
          <h3 className="text-fg-default text-sm font-semibold">
            {isOperate ? 'Agent · Operate' : 'Chat · Ask'}
          </h3>
          <p className="text-fg-muted text-xs">
            {isOperate
              ? 'The shared character waves a small working hand'
              : 'The shared character speaks with an open mouth'}
          </p>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-6">
        {BUILT_IN_STATUS_CASES.map(({ status, label }) => (
          <div
            key={status}
            className="flex min-w-0 flex-col items-center gap-2"
          >
            <BuiltInAgentStateBadge mode={mode} status={status} />
            <span className="text-fg-muted text-center text-[11px] leading-tight">
              {label}
            </span>
          </div>
        ))}
      </div>
    </article>
  );
}

function QuestionNodePreview({
  stateCase,
  icon,
  expandedBadge,
}: {
  stateCase: StateCase;
  icon: AgentIconValue;
  expandedBadge: boolean;
}) {
  const { status, question, agentName } = stateCase;
  const isActive = stateCase.active === true;
  const isUnread = status === 'done-unread';
  const badge =
    isActive && agentName ? (
      <AgentRunBadge
        icon={icon}
        status="open"
        agentName={agentName}
        expanded={expandedBadge}
      />
    ) : status !== 'idle' && agentName ? (
      <AgentRunBadge
        icon={icon}
        status={status}
        agentName={agentName}
        expanded={expandedBadge}
      />
    ) : null;

  return (
    <article className="flex min-w-0 flex-col gap-3">
      <div className="text-center">
        <h2 className="text-fg-default text-sm font-semibold">
          {stateCase.label}
        </h2>
        <p className="text-fg-muted mx-auto mt-0.5 max-w-64 text-xs leading-relaxed">
          {stateCase.description}
        </p>
      </div>

      <div className="relative mx-auto mt-3 w-full max-w-72 pt-3">
        {badge ? (
          <div className="absolute top-0 left-3 z-10 -translate-y-1/2">
            {badge}
          </div>
        ) : null}

        <div
          className={cn(
            'question-sticky relative flex min-h-36 flex-col justify-between rounded-lg border p-5 shadow-md transition-all',
            isUnread && 'question-node-done-unviewed',
          )}
          style={{
            color: 'var(--question-fg)',
            backgroundColor: 'var(--question-bg)',
            borderColor: 'var(--question-border)',
          }}
        >
          <p className="text-base leading-snug font-semibold">{question}</p>
        </div>
      </div>
    </article>
  );
}

function ChoiceButton<T extends string>({
  value,
  selected,
  onSelect,
  children,
}: {
  value: T;
  selected: boolean;
  onSelect: (value: T) => void;
  children: ReactNode;
}) {
  return (
    <Button
      variant={selected ? 'solid' : 'ghost'}
      tone={selected ? 'info' : 'neutral'}
      size="sm"
      onClick={() => onSelect(value)}
      className="gap-1.5"
    >
      {children}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Question node · 1:1 canvas fidelity + zoom LOD lab
//
// Reproduces the REAL question sticky note pixel-for-pixel (same
// `--question-*` tokens, depth board, Comic Sans face, 12px padding,
// rounded-lg) so the proposed agent-status treatment can be compared 1:1
// against the live canvas. A zoom slider drives a continuous LOD takeover:
// as the node shrinks past a screen-width band, the corner avatar smoothly
// re-anchors to the node centre and the card fades, so the avatar becomes
// the node's stand-in instead of overwhelming it.
// ---------------------------------------------------------------------------

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Canvas-space size of the demo question node (px at 100% zoom). */
const LOD_NODE_W = 220;
const LOD_NODE_H = 132;
/** Screen-width band (px) over which the avatar takes over the node. */
const LOD_BAND_HI = 150;
const LOD_BAND_LO = 66;

/** Pixel-faithful reproduction of the real question sticky note. */
function StickyCard({
  screenW,
  screenH,
  bodyOpacity,
  zoom,
}: {
  screenW: number;
  screenH: number;
  bodyOpacity: number;
  zoom: number;
}) {
  const board = Math.max(2, 8 * zoom);
  const radius = Math.max(3, 8 * zoom);
  return (
    <div
      style={{ position: 'relative', width: screenW, height: screenH }}
      aria-hidden
    >
      {/* Depth board — the sticky's ::before, in the border colour. */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          transform: `translate(${board}px, ${board}px)`,
          background: 'var(--question-border)',
          borderRadius: radius,
          opacity: bodyOpacity,
        }}
      />
      {/* Card face. */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'var(--question-bg)',
          border: `1px solid var(--question-border)`,
          borderRadius: radius,
          opacity: bodyOpacity,
          overflow: 'hidden',
          padding: 12 * zoom,
        }}
      >
        <div
          style={{
            color: 'var(--question-fg)',
            fontFamily:
              '"Comic Sans MS", STXingkai, KaiTi, "Kaiti SC", cursive',
            fontSize: 18 * zoom,
            fontWeight: 600,
            lineHeight: 1.4,
          }}
        >
          How does semantic zoom work?
        </div>
      </div>
    </div>
  );
}

/**
 * Proposed agent status chip — warmer + rounder than the current techy
 * ring, so it belongs to the sticky-note family. Identity in the avatar;
 * state is a soft halo, not a hard conic gradient.
 */
function ProposedAgentChip({
  icon,
  status,
  size = 40,
}: {
  icon: AgentIconValue;
  status: AgentBadgeStatus;
  size?: number;
}) {
  const isOpen = status === 'open';
  const isRunning = status === 'running';
  const isError = status === 'error';
  const isUnread = status === 'done-unread';
  const haloColor = isError
    ? 'var(--danger)'
    : isRunning
      ? 'var(--info)'
      : 'var(--success)';
  const showHalo = isRunning || isError || isUnread;
  return (
    <div
      className="relative inline-flex items-center justify-center rounded-full"
      style={{
        width: size,
        height: size,
        background: isOpen ? 'transparent' : 'var(--bg-surface)',
        boxShadow: isOpen
          ? 'none'
          : showHalo
            ? `0 0 0 3px color-mix(in srgb, ${haloColor} 22%, transparent), 0 2px 8px color-mix(in srgb, var(--question-fg) 22%, transparent)`
            : '0 2px 8px color-mix(in srgb, var(--question-fg) 18%, transparent)',
        animation:
          isRunning || isUnread
            ? 'playground-question-attention-nudge 4s ease-in-out infinite'
            : undefined,
      }}
    >
      {isOpen ? (
        <svg
          className="pointer-events-none absolute -top-0.5 -left-0.5 overflow-visible"
          style={{ width: size * 1.1, height: size * 1.2 }}
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
      <AgentIcon
        shape={icon.shape}
        color={icon.color}
        size={Math.round(size * 0.8)}
        withFace
        motion={isRunning ? 'working' : 'none'}
        className="relative z-10"
      />
    </div>
  );
}

/** One canvas viewport rendering the node + badge at a simulated zoom. */
function LodViewport({
  icon,
  status,
  zoom,
  mode,
  label,
}: {
  icon: AgentIconValue;
  status: AgentBadgeStatus;
  zoom: number;
  mode: 'current' | 'proposed';
  label: string;
}) {
  const VW = 340;
  const VH = 210;
  const screenW = LOD_NODE_W * zoom;
  const screenH = LOD_NODE_H * zoom;
  // LOD takeover factor (proposed only).
  const t =
    mode === 'proposed'
      ? clamp01((LOD_BAND_HI - screenW) / (LOD_BAND_HI - LOD_BAND_LO))
      : 0;

  const nodeLeft = (VW - screenW) / 2;
  const nodeTop = (VH - screenH) / 2;
  const cx = VW / 2;
  const cy = VH / 2;

  // Corner anchor (matches the real badge offset {top:-22,left:-2} at
  // constant 40px screen size — centre ≈ node top-left + (18, -2)).
  const cornerX = nodeLeft + 18;
  const cornerY = nodeTop - 2;
  const badgeX = lerp(cornerX, cx, t);
  const badgeY = lerp(cornerY, cy, t);
  const bodyOpacity = mode === 'proposed' ? lerp(1, 0.12, t) : 1;
  const showTitle = t > 0.55;

  return (
    <div className="flex flex-col items-center gap-2">
      <span className="text-fg-muted text-xs font-medium">{label}</span>
      <div
        className="relative overflow-hidden rounded-xl"
        style={{
          width: VW,
          height: VH,
          background: 'var(--bg-default)',
          backgroundImage:
            'radial-gradient(color-mix(in srgb, var(--fg-subtle) 30%, transparent) 1px, transparent 1px)',
          backgroundSize: '16px 16px',
          border: '1px solid var(--edge-default)',
        }}
      >
        <div style={{ position: 'absolute', left: nodeLeft, top: nodeTop }}>
          <StickyCard
            screenW={screenW}
            screenH={screenH}
            bodyOpacity={bodyOpacity}
            zoom={zoom}
          />
        </div>

        {/* Badge — constant 40px screen size, re-anchored by the LOD factor. */}
        <div
          style={{
            position: 'absolute',
            left: badgeX,
            top: badgeY,
            transform: 'translate(-50%, -50%)',
          }}
        >
          {mode === 'proposed' ? (
            <div className="flex flex-col items-center gap-1">
              <ProposedAgentChip icon={icon} status={status} />
              {showTitle ? (
                <span
                  className="max-w-[120px] truncate rounded px-1 text-center"
                  style={{
                    color: 'var(--question-fg)',
                    fontFamily:
                      '"Comic Sans MS", STXingkai, KaiTi, "Kaiti SC", cursive',
                    fontSize: 12,
                    fontWeight: 600,
                    opacity: t,
                  }}
                >
                  How does semantic zoom work?
                </span>
              ) : null}
            </div>
          ) : (
            <ProposedAgentChip icon={icon} status={status} />
          )}
        </div>
      </div>
    </div>
  );
}

/** Interactive zoom-LOD lab + a static filmstrip of the transition. */
function QuestionNodeLodLab({ icon }: { icon: AgentIconValue }) {
  const [zoom, setZoom] = useState(1);
  const [status, setStatus] = useState<AgentBadgeStatus>('open');
  const screenW = Math.round(LOD_NODE_W * zoom);

  return (
    <div className="border-edge-default bg-surface rounded-2xl border p-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-fg-default font-semibold">
            Question node · 1:1 canvas fidelity + zoom LOD
          </h2>
          <p className="text-fg-muted mt-1 max-w-2xl text-sm">
            The sticky note is reproduced pixel-for-pixel. Drag the zoom to see
            the proposed smooth LOD takeover: the avatar re-anchors to the node
            centre and the card fades instead of being covered by a corner
            badge.
          </p>
        </div>
        <div className="flex items-center gap-1">
          {(
            [
              { value: 'open', label: 'Open' },
              { value: 'running', label: 'Running' },
              { value: 'done-unread', label: 'Unread' },
              { value: 'done-viewed', label: 'Done' },
              { value: 'error', label: 'Error' },
            ] as { value: AgentBadgeStatus; label: string }[]
          ).map((s) => (
            <Button
              key={s.value}
              variant={status === s.value ? 'solid' : 'ghost'}
              tone={status === s.value ? 'info' : 'neutral'}
              size="sm"
              onClick={() => setStatus(s.value)}
            >
              {s.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="mb-5 flex items-center gap-4">
        <span className="text-fg-muted w-24 text-xs">
          Zoom {Math.round(zoom * 100)}%
        </span>
        <input
          type="range"
          min={12}
          max={100}
          value={Math.round(zoom * 100)}
          onChange={(e) => setZoom(Number(e.target.value) / 100)}
          className="flex-1 accent-[var(--info)]"
          aria-label="Zoom"
        />
        <span className="text-fg-subtle w-40 text-right text-xs">
          node ≈ {screenW}px on screen
        </span>
      </div>

      <div className="flex flex-wrap justify-center gap-8">
        <LodViewport
          icon={icon}
          status={status}
          zoom={zoom}
          mode="current"
          label="现状 · corner badge (no LOD)"
        />
        <LodViewport
          icon={icon}
          status={status}
          zoom={zoom}
          mode="proposed"
          label="提案 · smooth avatar takeover"
        />
      </div>

      <div className="mt-8">
        <p className="text-fg-muted mb-3 text-xs font-medium">
          Proposed transition filmstrip (100% → 12%)
        </p>
        <div className="flex flex-wrap justify-center gap-4">
          {[1, 0.6, 0.36, 0.2, 0.12].map((z) => (
            <LodViewport
              key={z}
              icon={icon}
              status={status}
              zoom={z}
              mode="proposed"
              label={`${Math.round(z * 100)}%`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export default function AgentNodePlaygroundPage() {
  const [shape, setShape] = useState<AgentIconShape>('flower');
  const [color, setColor] = useState<AgentIconColor>('blue');
  const [expandedBadge, setExpandedBadge] = useState(false);
  const icon = { shape, color };

  return (
    <div className="bg-bg-default h-full overflow-auto">
      <header className="border-edge-default bg-bg-default/95 sticky top-0 z-20 flex flex-wrap items-center justify-between gap-4 border-b px-6 py-3 backdrop-blur-sm">
        <div>
          <h1 className="text-fg-default text-lg font-semibold">
            Agent × Question Node playground
          </h1>
          <p className="text-fg-muted text-xs">
            Identity stays in the avatar; motion and the semantic ring express
            execution state.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-1">
            {AGENT_ICON_SHAPES.map((value) => (
              <ChoiceButton
                key={value}
                value={value}
                selected={shape === value}
                onSelect={setShape}
              >
                <AgentIcon shape={value} color={color} size={18} withFace />
              </ChoiceButton>
            ))}
          </div>
          <div className="border-edge-default flex items-center gap-1 border-l pl-4">
            {AGENT_ICON_COLORS.map((value) => (
              <ChoiceButton
                key={value}
                value={value}
                selected={color === value}
                onSelect={setColor}
              >
                <AgentIcon shape={shape} color={value} size={18} withFace />
              </ChoiceButton>
            ))}
          </div>
          <Button
            variant={expandedBadge ? 'solid' : 'outline'}
            tone={expandedBadge ? 'info' : 'neutral'}
            size="sm"
            onClick={() => setExpandedBadge((current) => !current)}
          >
            {expandedBadge ? 'Name visible' : 'Avatar only'}
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        <section className="mb-14">
          <QuestionNodeLodLab icon={icon} />
        </section>

        <section className="grid grid-cols-1 gap-x-8 gap-y-12 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {STATE_CASES.map((stateCase) => (
            <QuestionNodePreview
              key={stateCase.label}
              stateCase={stateCase}
              icon={icon}
              expandedBadge={expandedBadge}
            />
          ))}
        </section>

        <section className="mt-14">
          <div className="mb-5">
            <h2 className="text-fg-default font-semibold">
              Built-in avatar language candidates
            </h2>
            <p className="text-fg-muted mt-1 text-sm">
              Seven ways to preserve Chat and Agent semantics while matching the
              visual weight and identity language of the external Agent avatars.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {BUILT_IN_AVATAR_TREATMENTS.map((candidate) => (
              <article
                key={candidate.treatment}
                className={cn(
                  'bg-surface rounded-lg border p-4',
                  candidate.recommended
                    ? 'border-info ring-info/20 ring-2'
                    : 'border-edge-default',
                )}
              >
                <div className="flex h-16 items-center justify-center gap-6">
                  <div className="flex flex-col items-center gap-1.5">
                    <BuiltInAvatarCandidate
                      mode="ask"
                      treatment={candidate.treatment}
                    />
                    <span className="text-fg-subtle text-[10px]">Chat</span>
                  </div>
                  <div className="flex flex-col items-center gap-1.5">
                    <BuiltInAvatarCandidate
                      mode="operate"
                      treatment={candidate.treatment}
                    />
                    <span className="text-fg-subtle text-[10px]">Agent</span>
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <h3 className="text-fg-default text-sm font-semibold">
                    {candidate.label}
                  </h3>
                  {candidate.recommended ? (
                    <span className="bg-info-bg text-info rounded-full px-1.5 py-0.5 text-[10px] font-semibold">
                      Recommended
                    </span>
                  ) : null}
                </div>
                <p className="text-fg-muted mt-1 text-xs leading-relaxed">
                  {candidate.note}
                </p>
              </article>
            ))}
          </div>
        </section>

        <section className="mt-14">
          <div className="mb-5">
            <h2 className="text-fg-default font-semibold">
              Built-in Agent state preview
            </h2>
            <p className="text-fg-muted mt-1 text-sm">
              The refined mode characters inside every selected Question status
              treatment.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <BuiltInAgentModeRow mode="ask" />
            <BuiltInAgentModeRow mode="operate" />
          </div>
        </section>

        <section className="mt-14">
          <div className="mb-5">
            <h2 className="text-fg-default font-semibold">
              Cloud replacement candidates
            </h2>
            <p className="text-fg-muted mt-1 text-sm">
              Each candidate is shown static and with the existing rotating body
              motion.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {CANDIDATE_SHAPES.map((candidate) => (
              <article
                key={candidate.shape}
                className="border-edge-default bg-surface rounded-lg border p-4"
              >
                <div className="flex h-20 items-center justify-around">
                  <CandidateAgentIcon shape={candidate.shape} />
                  <CandidateAgentIcon shape={candidate.shape} running />
                </div>
                <h3 className="text-fg-default mt-2 text-sm font-semibold">
                  {candidate.label}
                </h3>
                <p className="text-fg-muted mt-1 text-xs leading-relaxed">
                  {candidate.note}
                </p>
              </article>
            ))}
          </div>
        </section>

        <section className="mt-14">
          <div className="mb-5">
            <h2 className="text-fg-default font-semibold">
              Unread container motion candidates
            </h2>
            <p className="text-fg-muted mt-1 text-sm">
              Each option moves briefly, then stays quiet for most of its
              four-second cycle.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            {ATTENTION_MOTIONS.map((candidate) => (
              <article
                key={candidate.motion}
                className={cn(
                  'bg-surface rounded-lg border p-4',
                  candidate.motion === SELECTED_ATTENTION_MOTION
                    ? 'border-success ring-success/20 ring-2'
                    : 'border-edge-default',
                )}
              >
                <AttentionMotionCandidate
                  motion={candidate.motion}
                  icon={icon}
                />
                <h3 className="text-fg-default mt-2 text-sm font-semibold">
                  {candidate.label}
                </h3>
                <p className="text-fg-muted mt-1 text-xs leading-relaxed">
                  {candidate.note}
                </p>
              </article>
            ))}
          </div>
        </section>

        <section className="mt-14">
          <div className="mb-5">
            <h2 className="text-fg-default font-semibold">
              Status ring language candidates
            </h2>
            <p className="text-fg-muted mt-1 text-sm">
              Identity stays untouched while gradients and geometry carry the
              state.
            </p>
          </div>
          <div className="space-y-8">
            {STATUS_RING_GROUPS.map((group) => (
              <div key={group.state}>
                <div className="mb-3">
                  <h3 className="text-fg-default text-sm font-semibold">
                    {group.state}
                  </h3>
                  <p className="text-fg-muted mt-0.5 text-xs">
                    {group.description}
                  </p>
                </div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                  {group.candidates.map((candidate) => (
                    <article
                      key={candidate.variant}
                      className={cn(
                        'bg-surface rounded-lg border p-4',
                        candidate.recommended
                          ? 'border-info ring-info/15 ring-2'
                          : 'border-edge-default',
                      )}
                    >
                      <StatusRingCandidate
                        variant={candidate.variant}
                        icon={icon}
                      />
                      <div className="mt-2 flex items-center justify-between gap-3">
                        <h4 className="text-fg-default text-sm font-semibold">
                          {candidate.label}
                        </h4>
                        {candidate.recommended ? (
                          <span className="text-info text-[10px] font-semibold uppercase">
                            Recommended
                          </span>
                        ) : null}
                      </div>
                      <p className="text-fg-muted mt-1 text-xs leading-relaxed">
                        {candidate.note}
                      </p>
                    </article>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="border-edge-default bg-surface mt-12 rounded-xl border p-5">
          <div className="flex flex-wrap items-start justify-between gap-5">
            <div className="max-w-xl">
              <h2 className="text-fg-default font-semibold">
                Proposed visual contract
              </h2>
              <p className="text-fg-muted mt-1 text-sm leading-relaxed">
                Profile shape and color identify the agent. Motion makes the
                avatar itself communicate activity, while the semantic ring
                keeps every state readable when motion is disabled. Opening a
                conversation turns the avatar container into a chat bubble with
                a lower-left tail. Running uses icon motion because the agent is
                working; unviewed terminal outcomes use container motion because
                they need attention. Viewed answers retain a neutral outline
                without motion or glow. Only information that cannot fit into
                the avatar, such as a conflict count, remains a separate badge.
              </p>
            </div>
            <div className="flex flex-wrap gap-5 text-xs">
              <LegendItem
                icon={Eye}
                label="Unviewed outcomes nudge"
                color="var(--success)"
              />
              <LegendItem
                icon={Loader}
                label="Running avatar works"
                color="var(--info)"
              />
              <LegendItem
                icon={X}
                label="Outcome color stays semantic"
                color="var(--danger)"
              />
              <LegendItem
                icon={AlertTriangle}
                label="Skipped writes count"
                color="var(--warning)"
              />
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

function LegendItem({
  icon: Icon,
  label,
  color,
}: {
  icon: LucideIcon;
  label: string;
  color: string;
}) {
  return (
    <div className="text-fg-muted flex items-center gap-1.5">
      <span
        className="flex size-5 items-center justify-center rounded-full text-white"
        style={{ backgroundColor: color }}
      >
        <Icon size={11} />
      </span>
      {label}
    </div>
  );
}
