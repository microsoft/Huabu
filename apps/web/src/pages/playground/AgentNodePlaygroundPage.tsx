// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { AlertTriangle, Eye, Loader, ShieldQuestion, X } from 'lucide-react';
import { useRef, useState } from 'react';

import '@/components/Nodes/question/QuestionAgentBadge.css';

import './AgentNodePlaygroundPage.css';

import {
  AGENT_ICON_COLORS,
  AGENT_ICON_SHAPES,
  AgentIcon,
} from '@/components/Common/AgentIcon';
import { Button } from '@/components/Common/Button';
import { cn } from '@/components/Common/cn';
import { CommandBlock } from '@/components/Common/CommandBlock';
import { QuestionTakeoverMark } from '@/components/Nodes/question/QuestionTakeoverMark';
import {
  AgentModeIcon,
  ChatModeIcon,
} from '@/components/Panels/ChatPanel/ModeIcon';
import {
  badgeSizeForNode,
  collapseProgress,
  collapsedMarkSize,
  lerp as lerpTakeover,
  resolveQuestionStage,
} from '@/config/nodeTakeover';

import type {
  AgentIconColor,
  AgentIconMotion,
  AgentIconShape,
  AgentIconValue,
} from '@/components/Common/AgentIcon';
import type { QuestionLodStage } from '@/config/nodeTakeover';
import type { QuestionAgentPresentation } from '@/utils/questionAgentPresentation';
import type { LucideIcon } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';

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

type ApprovalState = 'running' | 'awaiting-approval';

const APPROVAL_DEMO_OPTIONS = [
  { id: 'allow-once', label: 'Allow once', reject: false, primary: true },
  { id: 'allow-always', label: 'Always allow', reject: false, primary: false },
  { id: 'reject-once', label: 'Reject', reject: true, primary: false },
] as const;

function ApprovalStatusMark({
  icon,
  size,
  state,
}: {
  icon: AgentIconValue;
  size: number;
  state: ApprovalState;
}) {
  const awaitingApproval = state === 'awaiting-approval';
  const innerSize = Math.round(size * 0.8);
  const satelliteSize = Math.max(12, Math.min(20, size * 0.45));

  return (
    <div
      className={cn(
        'question-agent-badge relative isolate inline-flex items-center justify-center rounded-full border-solid',
        awaitingApproval
          ? 'question-agent-ring-approval border-transparent'
          : 'question-agent-ring-running border-transparent',
      )}
      style={
        {
          '--question-agent-badge-size': `${size}px`,
          '--question-agent-running-ring': LOD_AGENT_COLOR_HEX[icon.color],
          background: 'color-mix(in srgb, var(--question-bg) 32%, white)',
          borderWidth: Math.max(0.75, Math.min(2, size * 0.05)),
        } as CSSProperties
      }
      role="img"
      aria-label={
        awaitingApproval
          ? 'External Agent · Approval required'
          : 'External Agent · Running'
      }
    >
      <AgentIcon
        shape={icon.shape}
        color={icon.color}
        size={innerSize}
        withFace
        motion={awaitingApproval ? 'none' : 'working'}
        className="relative z-10 shrink-0"
      />
      {awaitingApproval ? (
        <span
          className="bg-warning text-fg-inverse absolute -top-1.5 -right-1.5 z-20 flex items-center justify-center rounded-full shadow-sm"
          style={{ width: satelliteSize, height: satelliteSize }}
          aria-hidden
        >
          <ShieldQuestion size={Math.max(8, satelliteSize * 0.62)} />
        </span>
      ) : null}
    </div>
  );
}

function ApprovalRequiredReference({ icon }: { icon: AgentIconValue }) {
  const [state, setState] = useState<ApprovalState>('awaiting-approval');
  const [resolution, setResolution] = useState<string | null>(null);
  const awaitingApproval = state === 'awaiting-approval';

  const selectState = (nextState: ApprovalState) => {
    setState(nextState);
    if (nextState === 'awaiting-approval') setResolution(null);
  };

  return (
    <section className="border-edge-default mt-6 border-t pt-6">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h2 className="text-fg-default font-semibold">
              Approval required · production reference
            </h2>
            <span className="bg-warning-bg text-warning rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase">
              Shipped
            </span>
          </div>
          <p className="text-fg-muted max-w-3xl text-sm">
            The Agent is paused, not running: motion stops, a static amber hold
            ring replaces the blue sweep, and a shield satellite makes the
            required action legible without recolouring the Agent identity.
          </p>
        </div>
        <div className="bg-bg-default flex items-center gap-1 rounded-lg p-1">
          {(
            [
              { value: 'running', label: 'Running' },
              { value: 'awaiting-approval', label: 'Approval required' },
            ] as { value: ApprovalState; label: string }[]
          ).map((option) => (
            <Button
              key={option.value}
              size="sm"
              variant={state === option.value ? 'solid' : 'ghost'}
              tone={
                state === option.value
                  ? option.value === 'awaiting-approval'
                    ? 'warning'
                    : 'info'
                  : 'neutral'
              }
              onClick={() => selectState(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(18rem,0.65fr)]">
        <div className="border-edge-default bg-bg-default overflow-hidden rounded-xl border">
          <div className="grid min-h-72 place-items-center bg-[radial-gradient(color-mix(in_srgb,var(--fg-subtle)_30%,transparent)_1px,transparent_1px)] bg-size-[16px_16px] p-8 sm:grid-cols-2">
            <div className="flex flex-col items-center gap-3">
              <div className="relative">
                <StickyCard
                  screenW={220}
                  screenH={132}
                  bodyOpacity={1}
                  zoom={1}
                />
                <div className="absolute top-1 left-2 -translate-x-1/2 -translate-y-1/2">
                  <ApprovalStatusMark icon={icon} size={37} state={state} />
                </div>
              </div>
              <span className="text-fg-muted text-xs">Readable corner</span>
            </div>

            <div className="flex flex-col items-center gap-3">
              <div className="flex h-32 w-32 items-center justify-center">
                <ApprovalStatusMark icon={icon} size={24} state={state} />
              </div>
              <span className="text-fg-muted text-xs">Collapsed takeover</span>
            </div>
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          {awaitingApproval ? (
            <div
              className="border-edge-default bg-bg-default flex min-h-72 flex-col rounded-xl border p-3"
              aria-live="polite"
            >
              <div className="text-fg-muted flex items-center gap-1.5 px-2 py-1.5 text-xs">
                <ShieldQuestion
                  size={14}
                  className={
                    resolution
                      ? 'text-fg-subtle shrink-0'
                      : 'text-warning shrink-0'
                  }
                  aria-hidden
                />
                <span className="text-fg-default font-medium">
                  Run npm install
                </span>
                <span aria-hidden>·</span>
                <span>{resolution ?? 'Permission requested'}</span>
              </div>

              {!resolution ? (
                <div
                  role="group"
                  aria-label="Agent permission request"
                  className="border-edge-default bg-surface mt-auto rounded-xl border"
                >
                  <div className="flex items-center gap-2 px-3 pt-2.5">
                    <span className="bg-warning-bg text-warning flex size-6 shrink-0 items-center justify-center rounded-full">
                      <ShieldQuestion size={14} aria-hidden />
                    </span>
                    <span className="text-fg-default text-sm font-medium">
                      Run npm install
                    </span>
                  </div>
                  <CommandBlock
                    text="npm install"
                    className="bg-warning-bg/45 [&_pre>span]:text-warning mx-3 mt-2 border-transparent"
                  />
                  <div className="flex flex-wrap gap-2 p-3 pt-2.5">
                    {APPROVAL_DEMO_OPTIONS.map((option) => (
                      <Button
                        key={option.id}
                        size="sm"
                        variant={option.primary ? 'solid' : 'outline'}
                        tone={option.reject ? 'danger' : 'warning'}
                        onClick={() => setResolution(option.label)}
                      >
                        {option.label}
                      </Button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="border-edge-default bg-bg-default rounded-xl border p-4">
              <div className="flex min-w-0 items-start gap-3">
                <span className="bg-info-bg text-info mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full">
                  <Loader
                    size={17}
                    className="animate-spin motion-reduce:animate-none"
                    aria-hidden
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="text-fg-default text-sm font-semibold">
                    Agent is running
                  </h3>
                  <p className="text-fg-muted mt-1 text-xs leading-relaxed wrap-break-word">
                    The Agent continues working without requiring input.
                  </p>
                </div>
              </div>
            </div>
          )}

          <div className="border-edge-default rounded-xl border p-4">
            <h3 className="text-fg-default text-xs font-semibold">
              State priority
            </h3>
            <div className="text-fg-muted mt-3 flex flex-wrap items-center gap-1.5 text-xs">
              <span className="bg-warning-bg text-warning rounded-full px-2 py-1 font-medium">
                Approval
              </span>
              <span aria-hidden>›</span>
              <span className="bg-bg-default rounded-full px-2 py-1">Open</span>
              <span aria-hidden>›</span>
              <span className="bg-info-bg text-info rounded-full px-2 py-1">
                Running
              </span>
              <span aria-hidden>›</span>
              <span className="bg-bg-default rounded-full px-2 py-1">
                Result
              </span>
            </div>
            <p className="text-fg-subtle mt-3 text-xs leading-relaxed">
              Message history records the request and result. The single
              actionable tray stays above the composer while the request is
              unresolved, keeping recent execution context adjacent.
            </p>
          </div>
        </div>
      </div>

      <div className="text-fg-subtle mt-4 grid gap-2 text-xs sm:grid-cols-3">
        <span>Static amber ring · no working motion</span>
        <span>Shield remains distinct from Conflict</span>
        <span>Reduced motion keeps the full visual signal</span>
      </div>
    </section>
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
const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Brand-avatar palette (mirrors `AgentIcon`'s private `COLOR_HEX`). */
const LOD_AGENT_COLOR_HEX: Record<AgentIconColor, string> = {
  blue: '#00A4EF',
  red: '#F25022',
  yellow: '#FFB900',
  green: '#7FBA00',
};

/** Canvas-space size of the demo question node (px at 100% zoom). */
const LOD_NODE_W = 220;
const LOD_NODE_H = 132;
/** Screen-width band (px) over which the avatar takes over the node. */
const LOD_BAND_HI = 150;
const LOD_BAND_LO = 66;

/**
 * Avatar diameter (screen px) for the proposed LOD takeover.
 *
 * The avatar is NOT a constant screen size. It tracks the node's on-screen
 * size on a concave curve so it always reads as "part of" the body:
 *   - zoomed in  → grows with the node (up to {@link AVATAR_MAX_PX}) so it
 *     never looks like a tiny sticker stranded on a huge card;
 *   - zoomed out → eases down toward {@link AVATAR_MIN_DOT_PX} so a field of
 *     many nodes collapses into tidy dots instead of a crowd of equal chips.
 *
 * The concave gamma (<1) climbs out of the dot quickly and then flattens, so
 * most of the useful zoom range shows a legible identity rather than spending
 * it near either extreme. All five numbers are pure tuning knobs.
 */
const AVATAR_MIN_DOT_PX = 14;
const AVATAR_MAX_PX = 88;
const AVATAR_NODE_REP_MIN = 24;
const AVATAR_NODE_REP_MAX = 520;
const AVATAR_GAMMA = 0.7;

/**
 * Detail LOD for the avatar itself. The hand-drawn face and thin shape strokes
 * turn to mush once the avatar is only a handful of pixels wide, so detail is
 * shed in two steps as it shrinks:
 *   - below {@link AVATAR_DOT_MAX} → a single solid dot in the agent's identity
 *     colour (crispest possible mark at a few px);
 *   - below {@link AVATAR_FACE_MIN} → the shape silhouette WITHOUT the face, so
 *     the outline stays clean instead of a muddy scribble;
 *   - at/above {@link AVATAR_FACE_MIN} → the full detailed avatar with its face.
 */
const AVATAR_DOT_MAX = 18;
const AVATAR_FACE_MIN = 24;

/**
 * Avatar size (px) at/below which the title caption is fully hidden — set so
 * the caption only disappears as the avatar collapses toward a dot, not while
 * it is still a legible node stand-in.
 */
const AVATAR_TITLE_MIN = 14;
/** Avatar size (px) at/above which the title caption is fully revealed. */
const AVATAR_TITLE_FULL = 24;

/**
 * Maps a node's on-screen size to an avatar diameter along the concave curve
 * described above. Uses the geometric mean of width/height so a wide-short
 * and a tall-narrow node of equal area land on the same size — matching the
 * shared semantic-zoom philosophy.
 */
function avatarSizeForNode(screenW: number, screenH: number): number {
  const rep = Math.sqrt(Math.max(0, screenW) * Math.max(0, screenH));
  const n = clamp01(
    (rep - AVATAR_NODE_REP_MIN) / (AVATAR_NODE_REP_MAX - AVATAR_NODE_REP_MIN),
  );
  const eased = Math.pow(n, AVATAR_GAMMA);
  return Math.round(
    AVATAR_MIN_DOT_PX + (AVATAR_MAX_PX - AVATAR_MIN_DOT_PX) * eased,
  );
}

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

type ChipSource = 'external' | 'chat' | 'agent';

type BuiltInFace =
  | 'chat-smile'
  | 'chat-sparkle'
  | 'chat-wink'
  | 'chat-grin'
  | 'agent-cursor'
  | 'agent-wave'
  | 'agent-hands';

const BUILT_IN_FACE_VARIANTS: Array<{
  face: BuiltInFace;
  group: 'Chat' | 'Agent';
  label: string;
}> = [
  { face: 'chat-smile', group: 'Chat', label: 'Open smile' },
  { face: 'chat-sparkle', group: 'Chat', label: 'Sparkle eyes' },
  { face: 'chat-wink', group: 'Chat', label: 'Wink' },
  { face: 'chat-grin', group: 'Chat', label: 'Big grin' },
  { face: 'agent-cursor', group: 'Agent', label: 'Cursor' },
  { face: 'agent-wave', group: 'Agent', label: 'Waving hand' },
  { face: 'agent-hands', group: 'Agent', label: 'Hands up' },
];

/**
 * Chubby rounded 5-point "Huabu star" body + hand-drawn face — the built-in
 * agent identity, in a single fixed Huabu blue. No corner badge: Chat vs Agent
 * is carried by the face. Chat faces lead with a big, expressive mouth; Agent
 * faces add little hands (it acts on the canvas). Pass an explicit `face` to
 * preview a specific candidate; otherwise `mode` picks a sensible default. The
 * spiky polygon is fattened by a thick round-joined stroke in its own fill
 * colour. Running reuses the external avatar's body wobble.
 */
function BuiltInStarBody({
  mode,
  size,
  motion = 'none',
  face,
  showFace = true,
}: {
  mode: BuiltInAgentMode;
  size: number;
  motion?: AgentIconMotion;
  face?: BuiltInFace;
  /** Draw the hand-drawn face. Off at small sizes where it reads as mush. */
  showFace?: boolean;
}) {
  const resolved: BuiltInFace =
    face ?? (mode === 'operate' ? 'agent-hands' : 'chat-smile');
  const fill = '#00A4EF';
  const ink = '#24221E';

  const star = (
    <polygon
      points="60,24 71.2,44.6 94.2,48.9 78.1,65.9 81.2,89.1 60,79 38.8,89.1 41.9,65.9 25.8,48.9 48.8,44.6"
      fill={fill}
      stroke={fill}
      strokeWidth={11}
      strokeLinejoin="round"
      strokeLinecap="round"
    />
  );

  // Happy arced eyes for the chatty faces; calm vertical eyes for the working
  // agent faces.
  const eyesLine = (
    <>
      <path d="M51 52 L50 59" />
      <path d="M70 52 L69 59" />
    </>
  );
  const roundEyes = (
    <>
      <circle cx="52" cy="55" r="3.5" fill={ink} stroke="none" />
      <circle cx="68" cy="55" r="3.5" fill={ink} stroke="none" />
    </>
  );
  const sparkleEyes = (
    <>
      <circle cx="52" cy="55.5" r="3.9" fill={ink} stroke="none" />
      <circle cx="68" cy="55.5" r="3.9" fill={ink} stroke="none" />
      <circle cx="50.6" cy="54.1" r="1.2" fill="#fff" stroke="none" />
      <circle cx="66.6" cy="54.1" r="1.2" fill="#fff" stroke="none" />
    </>
  );
  // A soft open smile shared by a few of the chatty faces.
  const openSmile = <path d="M52 66 C56 72 64 72 68 66" />;

  // `strokeEls` render inside the shared ink stroke group; `fillEls` render
  // afterwards (filled eyes, cursor, blue mitten hands).
  let strokeEls: ReactNode;
  let fillEls: ReactNode = null;

  switch (resolved) {
    case 'chat-smile':
      strokeEls = openSmile;
      fillEls = roundEyes;
      break;
    case 'chat-sparkle':
      strokeEls = <path d="M55 67 C58 70 62 70 65 67" />;
      fillEls = sparkleEyes;
      break;
    case 'chat-wink':
      strokeEls = (
        <>
          <path d="M64 56 C66 54 69 54 71 56" />
          {openSmile}
        </>
      );
      fillEls = <circle cx="52" cy="55" r="3.5" fill={ink} stroke="none" />;
      break;
    case 'chat-grin':
      strokeEls = (
        <>
          <path d="M49 55 C51 52 54 52 56 55" />
          <path d="M64 55 C66 52 69 52 71 55" />
          <path d="M50 64 C55 75 65 75 70 64" />
          <path d="M53 65 L67 65" />
        </>
      );
      break;
    case 'agent-cursor':
      strokeEls = eyesLine;
      fillEls = (
        <path
          d="M56 59 L56 75 L60 71 L62.5 77 L65 76 L62.5 70 L67 70 Z"
          fill={ink}
          stroke={ink}
          strokeWidth="1"
          strokeLinejoin="round"
        />
      );
      break;
    case 'agent-wave':
      strokeEls = (
        <>
          {eyesLine}
          <path d="M55 67 C59 69 63 69 67 67" />
          <path d="M79 76 C86 72 89 65 87 58" />
        </>
      );
      fillEls = (
        <circle
          cx="87"
          cy="55"
          r="4.6"
          fill={fill}
          stroke={ink}
          strokeWidth="2.4"
        />
      );
      break;
    case 'agent-hands':
      strokeEls = (
        <>
          {eyesLine}
          <path d="M55 67 C59 69 63 69 67 67" />
          <path d="M41 78 C34 73 32 66 35 60" />
          <path d="M79 78 C86 73 88 66 85 60" />
        </>
      );
      fillEls = (
        <>
          <circle
            cx="34"
            cy="57"
            r="4.4"
            fill={fill}
            stroke={ink}
            strokeWidth="2.4"
          />
          <circle
            cx="86"
            cy="57"
            r="4.4"
            fill={fill}
            stroke={ink}
            strokeWidth="2.4"
          />
        </>
      );
      break;
  }

  return (
    <svg width={size} height={size} viewBox="14 10.5 92 92" aria-hidden>
      {motion === 'working' ? (
        <g className="agent-icon-working-body">{star}</g>
      ) : (
        <g>{star}</g>
      )}
      {showFace ? (
        <>
          <g
            fill="none"
            stroke={ink}
            strokeWidth="4.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {strokeEls}
          </g>
          {fillEls}
        </>
      ) : null}
    </svg>
  );
}

/**
 * Faithful 1:1 copy of the shipped `QuestionAgentBadge` visual language so
 * the LOD lab confirms the exact final template. It reuses the shipped badge
 * CSS (`question-agent-ring-running` gradient sweep, `question-agent-ring-error`
 * alert segments, `question-agent-attention` nudge) instead of re-inventing
 * the rings, and renders either an external Agent avatar or the built-in
 * mode-character (Chat / Agent).
 */
function LodAgentChip({
  icon,
  status,
  source,
  size = 40,
  conflictCount = 0,
}: {
  icon: AgentIconValue;
  status: AgentBadgeStatus;
  source: ChipSource;
  size?: number;
  conflictCount?: number;
}) {
  const isOpen = status === 'open';
  const isRunning = status === 'running';
  const isError = status === 'error';
  const isUnread = status === 'done-unread';
  const hasConflict = status === 'conflict' || conflictCount > 0;
  const needsAttention = isUnread || isError || hasConflict;
  const attentionColor = isError
    ? 'var(--danger)'
    : hasConflict
      ? 'var(--warning)'
      : 'var(--success)';

  // Mirror the real badge's border + shadow logic. `running` and
  // `error` draw their ring via the shipped `::before` classes, so they stay
  // transparent here; the quiet ring covers done-viewed.
  let ringBorderColor = 'var(--question-agent-quiet-ring)';
  let ringBoxShadow = 'none';
  if (isOpen || isRunning) {
    ringBorderColor = 'transparent';
  } else if (needsAttention) {
    // All three unviewed outcomes (done-unread, error, conflict) share ONE
    // attention halo — a crisp inner ring + a wider outer glow — and differ
    // only by colour + ring geometry. done-viewed stays quiet (no glow).
    ringBoxShadow = `0 0 0 3px color-mix(in srgb, ${attentionColor} 26%, transparent), 0 0 12px 2px color-mix(in srgb, ${attentionColor} 42%, transparent)`;
    // Error draws its segmented `::before` ring, so keep its border
    // transparent; done-unread / conflict use a solid identity-coloured ring.
    ringBorderColor = isError ? 'transparent' : attentionColor;
  }

  const innerSize = Math.round(size * 0.8);
  const conflictBadgeCount =
    status === 'conflict' ? conflictCount || 2 : conflictCount;

  // Preview: tie the running sweep to the agent's own identity colour so the
  // avatar "lights up in its own colour" while working. External agents use
  // their picked colour; built-in modes use their character colour (Chat blue
  // / Agent green). Scoped to the lab via the CSS var; the shipped badge keeps
  // its `--info` default until the template is locked.
  const runningRingColor =
    source === 'external'
      ? LOD_AGENT_COLOR_HEX[icon.color]
      : source === 'agent'
        ? LOD_AGENT_COLOR_HEX.green
        : LOD_AGENT_COLOR_HEX.blue;

  // Warm off-white "sticker" fill (paler), shared by the chip body and the
  // open chat bubble.
  const stickerFill = 'color-mix(in srgb, var(--question-bg) 32%, white)';
  const chipStyle: CSSProperties = {
    // The shipped `.question-agent-badge` CSS pins width/height to
    // `--question-agent-badge-size` with `!important`, so a plain inline
    // width/height is ignored. Drive that variable instead so the container,
    // the `open` bubble (1.1×/1.2×) and the avatar (0.8×) all scale together
    // with the curve — otherwise the container stays 36px while the bubble
    // grows, stranding the icon in a corner.
    ['--question-agent-badge-size' as string]: `${size}px`,
    width: size,
    height: size,
    background: isOpen ? 'transparent' : stickerFill,
    borderColor: ringBorderColor,
    boxShadow: ringBoxShadow,
    ['--question-agent-running-ring' as string]: runningRingColor,
  };

  const chip = (
    <div
      className={cn(
        'question-agent-badge relative inline-flex items-center justify-center rounded-full border-2',
        isRunning &&
          'question-agent-ring-running border-transparent shadow-none',
        isError && 'question-agent-ring-error border-transparent',
        needsAttention && 'question-agent-attention',
      )}
      style={chipStyle}
    >
      {isOpen ? (
        <svg
          className="pointer-events-none absolute overflow-visible"
          style={{
            // The bubble's round body (viewBox centre 22,22 within 44×48)
            // must sit on the chip centre so the icon reads as centred. At
            // size*1.1 × size*1.2 the body centre lands at 0.55·size, so a
            // -0.05·size offset re-centres it — proportional, unlike the old
            // fixed 2px nudge that drifted badly as the avatar grew.
            //
            // Absolute offsets resolve against the padding box (inside the
            // chip's 2px border), while the icon is flex-centred in the
            // border box; without compensating for that 2px inset the bubble
            // sits 2px low/right of the icon — invisible when the avatar is
            // large but clearly off-centre once it shrinks. Subtract the
            // border width so both reference the same centre at every size.
            left: -size * 0.05 - 2,
            top: -size * 0.05 - 2,
            width: size * 1.1,
            height: size * 1.2,
          }}
          viewBox="0 0 44 48"
          aria-hidden
        >
          <path
            d="M22 2C11 2 2 11 2 22c0 8 4.5 14.5 11 18l-4 6 9-4.5c1.3.3 2.6.5 4 .5 11 0 20-9 20-20S33 2 22 2Z"
            fill={stickerFill}
            stroke="var(--question-border)"
            strokeWidth="2"
            strokeLinejoin="round"
          />
        </svg>
      ) : null}
      {size <= AVATAR_DOT_MAX ? (
        // Collapsed detail LOD: a crisp solid identity dot. The detailed
        // avatar is illegible at this scale, so drop it to the one mark that
        // stays sharp — a filled circle in the agent's colour with a hairline
        // light ring so it separates from the note behind it.
        <span
          className="relative z-10 rounded-full"
          style={{
            width: innerSize,
            height: innerSize,
            background: runningRingColor,
            boxShadow:
              'inset 0 0 0 1px color-mix(in srgb, white 45%, transparent)',
          }}
        />
      ) : source === 'external' ? (
        <AgentIcon
          shape={icon.shape}
          color={icon.color}
          size={innerSize}
          withFace={size >= AVATAR_FACE_MIN}
          motion={isRunning ? 'working' : 'none'}
          className="relative z-10"
        />
      ) : (
        <div className="relative z-10 leading-none">
          <BuiltInStarBody
            mode={source === 'agent' ? 'operate' : 'ask'}
            size={innerSize}
            showFace={size >= AVATAR_FACE_MIN}
            motion={isRunning ? 'working' : 'none'}
          />
        </div>
      )}
      {hasConflict ? (
        <span className="bg-warning-bg text-warning absolute -top-2.5 -right-3.5 z-20 flex h-6 min-w-6 items-center justify-center gap-0.5 rounded-full px-1.5 text-[11px] font-bold shadow-sm">
          <AlertTriangle size={12} />
          {conflictBadgeCount}
        </span>
      ) : null}
    </div>
  );

  return chip;
}

/**
 * Final 1:1 Question-node LOD preview.
 *
 * Unlike the historical proposal lab below, this preview deliberately imports
 * the production takeover math and `QuestionTakeoverMark` itself. It therefore
 * stays an exact executable reference for the shipped mark geometry, status
 * chrome, avatar detail threshold, and open-bubble treatment instead of copying
 * those decisions into a second playground-only implementation.
 */
function FinalQuestionNodeLodReference({ icon }: { icon: AgentIconValue }) {
  const [zoom, setZoom] = useState(1);
  const [status, setStatus] = useState<AgentBadgeStatus>('open');
  const [source, setSource] = useState<ChipSource>('external');
  const previousStage = useRef<QuestionLodStage>('readable');

  const screenW = LOD_NODE_W * zoom;
  const screenH = LOD_NODE_H * zoom;
  const stage = resolveQuestionStage(previousStage.current, screenW);
  previousStage.current = stage;

  const t = collapseProgress(screenW);
  const readableSize = badgeSizeForNode(screenW, screenH);
  const collapsedSize = collapsedMarkSize(screenW, screenH);
  const size = lerpTakeover(readableSize, collapsedSize, t);

  const viewportW = 520;
  const viewportH = 300;
  const nodeLeft = (viewportW - screenW) / 2;
  const nodeTop = (viewportH - screenH) / 2;
  const cornerX = nodeLeft + readableSize * 0.3;
  const cornerY = nodeTop + readableSize * 0.05;
  const centreX = nodeLeft + screenW / 2;
  const centreY = nodeTop + screenH / 2;
  const markX = lerpTakeover(cornerX, centreX, t);
  const markY = lerpTakeover(cornerY, centreY, t);

  const productionStatus =
    status === 'done-unread' ||
    status === 'done-viewed' ||
    status === 'conflict'
      ? 'done'
      : status;
  const unread =
    status === 'done-unread' || status === 'error' || status === 'conflict';
  const conflictCount = status === 'conflict' ? 2 : 0;
  const agent: QuestionAgentPresentation =
    source === 'external'
      ? { kind: 'external', alias: 'External Agent', icon }
      : {
          kind: 'internal',
          alias: 'Huabu',
          mode: source === 'agent' ? 'operate' : 'ask',
        };

  return (
    <div className="border-info bg-surface ring-info/15 rounded-2xl border p-6 ring-2">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <h2 className="text-fg-default font-semibold">
              Finalized · shipped Question-node states
            </h2>
            <span className="bg-info-bg text-info rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase">
              1:1 production
            </span>
          </div>
          <p className="text-fg-muted max-w-3xl text-sm">
            Locked production references for semantic zoom, status marks, and
            blocking permission requests. The earlier playground implementation
            remains below as proposal history.
          </p>
        </div>
        <div className="text-fg-subtle text-right text-xs">
          <div>width {Math.round(screenW)}px</div>
          <div>
            t {t.toFixed(2)} · mark {size.toFixed(1)}px · {stage}
          </div>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-fg-muted w-24 text-xs">Status</span>
        {(
          [
            { value: 'open', label: 'Open' },
            { value: 'running', label: 'Running' },
            { value: 'done-unread', label: 'Unread' },
            { value: 'done-viewed', label: 'Done' },
            { value: 'error', label: 'Error' },
            { value: 'conflict', label: 'Conflict' },
          ] as { value: AgentBadgeStatus; label: string }[]
        ).map((option) => (
          <Button
            key={option.value}
            variant={status === option.value ? 'solid' : 'ghost'}
            tone={status === option.value ? 'info' : 'neutral'}
            size="sm"
            onClick={() => setStatus(option.value)}
          >
            {option.label}
          </Button>
        ))}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-fg-muted w-24 text-xs">Agent source</span>
        {(
          [
            { value: 'external', label: 'External' },
            { value: 'chat', label: 'Built-in · Chat' },
            { value: 'agent', label: 'Built-in · Agent' },
          ] as { value: ChipSource; label: string }[]
        ).map((option) => (
          <Button
            key={option.value}
            variant={source === option.value ? 'solid' : 'ghost'}
            tone={source === option.value ? 'info' : 'neutral'}
            size="sm"
            onClick={() => setSource(option.value)}
          >
            {option.label}
          </Button>
        ))}
      </div>

      <div className="mb-5 flex items-center gap-4">
        <span className="text-fg-muted w-24 text-xs">
          Zoom {Math.round(zoom * 100)}%
        </span>
        <input
          type="range"
          min={1}
          max={300}
          value={Math.round(zoom * 100)}
          onChange={(event) => setZoom(Number(event.target.value) / 100)}
          className="accent-info flex-1"
          aria-label="Final Question node LOD zoom"
        />
      </div>

      <div className="flex justify-center overflow-hidden rounded-xl">
        <div
          className="relative"
          style={{
            width: viewportW,
            height: viewportH,
            background: 'var(--bg-default)',
            backgroundImage:
              'radial-gradient(color-mix(in srgb, var(--fg-subtle) 30%, transparent) 1px, transparent 1px)',
            backgroundSize: '16px 16px',
            border: '1px solid var(--edge-default)',
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: nodeLeft,
              top: nodeTop,
              opacity: stage === 'readable' ? 1 : 0,
              transition: 'opacity 200ms ease',
            }}
          >
            <StickyCard
              screenW={screenW}
              screenH={screenH}
              bodyOpacity={1}
              zoom={zoom}
            />
          </div>
          <div
            style={{
              position: 'absolute',
              left: markX,
              top: markY,
              transform: 'translate(-50%, -50%)',
            }}
          >
            <QuestionTakeoverMark
              state={{ stage, size }}
              status={productionStatus}
              agent={agent}
              unread={unread}
              conflictCount={conflictCount}
              interactive={false}
            />
          </div>
        </div>
      </div>

      <div className="text-fg-subtle mt-4 grid gap-2 text-xs sm:grid-cols-3">
        <span>64px → 24px smoothstep takeover</span>
        <span>Continuous mark geometry · binary card body</span>
        <span>Full avatar → identity dot below 7px</span>
      </div>

      <ApprovalRequiredReference icon={icon} />
    </div>
  );
}

/** One canvas viewport rendering the node + badge at a simulated zoom. */
function LodViewport({
  icon,
  status,
  source,
  zoom,
  mode,
  label,
  vw = 340,
  vh = 210,
}: {
  icon: AgentIconValue;
  status: AgentBadgeStatus;
  source: ChipSource;
  zoom: number;
  mode: 'current' | 'proposed';
  label: string;
  /** Viewport width in px. Callers grow it so a zoomed-in node still fits. */
  vw?: number;
  /** Viewport height in px. Callers grow it so a zoomed-in node still fits. */
  vh?: number;
}) {
  const VW = vw;
  const VH = vh;
  const screenW = LOD_NODE_W * zoom;
  const screenH = LOD_NODE_H * zoom;
  // LOD takeover factor (proposed only).
  const t =
    mode === 'proposed'
      ? clamp01((LOD_BAND_HI - screenW) / (LOD_BAND_HI - LOD_BAND_LO))
      : 0;

  // Avatar size rides a concave curve on the node's screen size instead of
  // being pinned to a constant screen size: it grows when you zoom in (so it
  // never looks lost on a big card) and eases down to a dot when you zoom out
  // (so a field of many nodes stays tidy). `current` keeps the shipped
  // constant-size corner badge for comparison.
  const avatarSize =
    mode === 'proposed' ? avatarSizeForNode(screenW, screenH) : 40;

  const nodeLeft = (VW - screenW) / 2;
  const nodeTop = (VH - screenH) / 2;
  const cx = VW / 2;
  const cy = VH / 2;

  // Corner anchor straddles the node's top-left corner; scale the offset with
  // the avatar so it keeps hugging the corner as the avatar grows/shrinks.
  // When the node is zoomed in past the viewport (screen size > viewport),
  // its true corner sits off-screen — clamp the anchor into the viewport so
  // the avatar keeps hugging the *visible* corner instead of vanishing, which
  // mirrors how a real canvas keeps the badge in view on an oversized node.
  const anchorMargin = avatarSize * 0.75;
  const cornerX = clamp(
    nodeLeft + avatarSize * 0.42,
    anchorMargin,
    VW - anchorMargin,
  );
  const cornerY = clamp(
    nodeTop - avatarSize * 0.05,
    anchorMargin,
    VH - anchorMargin,
  );
  const badgeX = lerp(cornerX, cx, t);
  const badgeY = lerp(cornerY, cy, t);
  // Fade the card fully out over the first half of the takeover so nothing of
  // the original problem node lingers behind the avatar.
  const bodyOpacity = mode === 'proposed' ? lerp(1, 0, clamp01(t / 0.5)) : 1;

  // Caption sequencing. The node's title only appears AFTER the card has fully
  // faded (t ≥ 0.5), so the caption and the original problem-node text never
  // show at once — the old logic let them overlap as a faint doubled line.
  // Once visible it stays crisp through the takeover band and only eases back
  // out as the avatar collapses toward a dot, so the deep zoom-out reads as a
  // clean dot rather than a dot with a floating caption.
  const captionIn = clamp01((t - 0.5) / 0.2);
  const titleReveal = clamp01(
    (avatarSize - AVATAR_TITLE_MIN) / (AVATAR_TITLE_FULL - AVATAR_TITLE_MIN),
  );
  const titleOpacity = captionIn * titleReveal;
  const showTitle = titleOpacity > 0.04;
  const titleFont = Math.round(lerp(9, 13, titleReveal));

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

        {/* Badge — size rides the avatar curve, re-anchored by the LOD factor. */}
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
              <LodAgentChip
                icon={icon}
                status={status}
                source={source}
                size={avatarSize}
              />
              {showTitle ? (
                <span
                  className="max-w-30 truncate rounded px-1 text-center"
                  style={{
                    color: 'var(--question-fg)',
                    fontFamily:
                      '"Comic Sans MS", STXingkai, KaiTi, "Kaiti SC", cursive',
                    fontSize: titleFont,
                    fontWeight: 600,
                    opacity: titleOpacity,
                  }}
                >
                  How does semantic zoom work?
                </span>
              ) : null}
            </div>
          ) : (
            <LodAgentChip icon={icon} status={status} source={source} />
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
  const [source, setSource] = useState<ChipSource>('external');
  const screenW = Math.round(LOD_NODE_W * zoom);
  const avatarPx = avatarSizeForNode(LOD_NODE_W * zoom, LOD_NODE_H * zoom);

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
              { value: 'conflict', label: 'Conflict' },
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

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-fg-muted w-24 text-xs">Agent source</span>
        {(
          [
            { value: 'external', label: 'External' },
            { value: 'chat', label: 'Built-in · Chat' },
            { value: 'agent', label: 'Built-in · Agent' },
          ] as { value: ChipSource; label: string }[]
        ).map((s) => (
          <Button
            key={s.value}
            variant={source === s.value ? 'solid' : 'ghost'}
            tone={source === s.value ? 'info' : 'neutral'}
            size="sm"
            onClick={() => setSource(s.value)}
          >
            {s.label}
          </Button>
        ))}
      </div>

      <div className="mb-5 flex items-center gap-4">
        <span className="text-fg-muted w-24 text-xs">
          Zoom {Math.round(zoom * 100)}%
        </span>
        <input
          type="range"
          min={1}
          max={300}
          value={Math.round(zoom * 100)}
          onChange={(e) => setZoom(Number(e.target.value) / 100)}
          className="accent-info flex-1"
          aria-label="Zoom"
        />
        <span className="text-fg-subtle w-56 text-right text-xs">
          node ≈ {screenW}px · avatar ≈ {avatarPx}px
        </span>
      </div>

      <div className="flex flex-wrap justify-center gap-8">
        <LodViewport
          icon={icon}
          status={status}
          source={source}
          zoom={zoom}
          mode="current"
          label="现状 · corner badge (no LOD)"
        />
        <LodViewport
          icon={icon}
          status={status}
          source={source}
          zoom={zoom}
          mode="proposed"
          label="提案 · smooth avatar takeover"
        />
      </div>

      <div className="mt-8">
        <p className="text-fg-muted mb-3 text-xs font-medium">
          Proposed transition filmstrip (300% → 1%)
        </p>
        <div className="flex flex-wrap justify-center gap-4">
          {[3, 1.5, 1, 0.5, 0.25, 0.12, 0.05, 0.01].map((z) => {
            // Grow the canvas so a zoomed-in node (e.g. 300%/150%, where the
            // node is larger than the default viewport) is drawn in full
            // instead of being clipped by the frame.
            const nodeW = LOD_NODE_W * z;
            const nodeH = LOD_NODE_H * z;
            const cellVW = Math.max(340, Math.round(nodeW + 72));
            const cellVH = Math.max(210, Math.round(nodeH + 72));
            return (
              <LodViewport
                key={z}
                icon={icon}
                status={status}
                source={source}
                zoom={z}
                mode="proposed"
                label={`${Math.round(z * 100)}%`}
                vw={cellVW}
                vh={cellVH}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

type HarmonyDirection = 'sticker' | 'stamp' | 'clean';

const HARMONY_DIRECTIONS: Array<{
  id: HarmonyDirection;
  label: string;
  note: string;
  recommended?: boolean;
}> = [
  {
    id: 'sticker',
    label: 'Sticker badge',
    note: 'Keep the warm note; the badge becomes a paper sticker — warm off-white, a soft warm shadow, and a slight tilt — instead of a crisp app chip.',
  },
  {
    id: 'stamp',
    label: 'Ink-stamp badge',
    note: 'Keep the warm note; drop the white chip entirely — the star sits in a hand-drawn ink ring, like a stamp pressed onto the paper.',
    recommended: true,
  },
  {
    id: 'clean',
    label: 'Clean sticky',
    note: 'Flatten the note instead: no depth board, a soft even shadow, and a crisp sans font — so it matches the clean vector badge.',
  },
];

/** The status badge rendered in each harmony direction's own chrome. */
function HarmonyBadge({ direction }: { direction: HarmonyDirection }) {
  if (direction === 'sticker') {
    return (
      <div
        className="flex items-center justify-center"
        style={{
          width: 40,
          height: 40,
          borderRadius: 11,
          background: 'color-mix(in srgb, var(--question-bg) 55%, white)',
          border:
            '1px solid color-mix(in srgb, var(--question-border) 45%, transparent)',
          boxShadow:
            '0 3px 7px color-mix(in srgb, var(--question-fg) 22%, transparent)',
          transform: 'rotate(-7deg)',
        }}
      >
        <BuiltInStarBody mode="ask" size={30} />
      </div>
    );
  }
  if (direction === 'stamp') {
    return (
      <div
        className="relative flex items-center justify-center"
        style={{ width: 42, height: 42 }}
      >
        <BuiltInStarBody mode="ask" size={38} />
        <svg
          width={44}
          height={44}
          viewBox="0 0 44 44"
          className="pointer-events-none absolute"
          style={{ inset: -1 }}
          aria-hidden
        >
          <path
            d="M22 3.5 C32 3 40.5 11 40.5 21.5 C41 32 33 40.5 22 40.5 C11.5 41 3.5 32.5 3.5 22 C3 12 11 4 22 3.5 Z"
            fill="none"
            stroke="var(--question-fg)"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    );
  }
  // clean — keep the crisp white chip (it now matches the cleaned note)
  return (
    <div
      className="flex items-center justify-center rounded-full"
      style={{
        width: 40,
        height: 40,
        background: 'var(--bg-surface)',
        boxShadow:
          '0 2px 6px color-mix(in srgb, var(--fg-default) 16%, transparent)',
      }}
    >
      <BuiltInStarBody mode="ask" size={32} />
    </div>
  );
}

/** A question sticky reproduced in one harmony direction's body style. */
function HarmonyStickyCard({ direction }: { direction: HarmonyDirection }) {
  const clean = direction === 'clean';
  return (
    <div className="relative" style={{ width: 240 }}>
      <div className="absolute -top-3 left-3 z-10">
        <HarmonyBadge direction={direction} />
      </div>
      {clean ? (
        <div
          className="relative flex min-h-32 flex-col justify-between rounded-xl p-5"
          style={{
            color: 'var(--question-fg)',
            backgroundColor: 'var(--question-bg)',
            border:
              '1px solid color-mix(in srgb, var(--question-border) 70%, transparent)',
            boxShadow:
              '0 4px 14px color-mix(in srgb, var(--question-fg) 14%, transparent)',
          }}
        >
          <p
            className="text-lg font-semibold"
            style={{
              fontFamily: 'Inter, system-ui, sans-serif',
              letterSpacing: '-0.01em',
            }}
          >
            How does semantic zoom work?
          </p>
        </div>
      ) : (
        <div className="relative">
          <div
            aria-hidden
            className="absolute inset-0 rounded-lg"
            style={{
              transform: 'translate(8px, 8px)',
              background: 'var(--question-border)',
            }}
          />
          <div
            className="relative flex min-h-32 flex-col justify-between rounded-lg border p-5 shadow-md"
            style={{
              color: 'var(--question-fg)',
              backgroundColor: 'var(--question-bg)',
              borderColor: 'var(--question-border)',
            }}
          >
            <p
              className="text-lg font-semibold"
              style={{
                fontFamily:
                  '"Comic Sans MS", STXingkai, KaiTi, "Kaiti SC", cursive',
              }}
            >
              How does semantic zoom work?
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export default function AgentNodePlaygroundPage() {
  const [shape, setShape] = useState<AgentIconShape>('flower');
  const [color, setColor] = useState<AgentIconColor>('blue');
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
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        <section className="mb-14">
          <FinalQuestionNodeLodReference icon={icon} />
        </section>

        <section className="mb-14">
          <QuestionNodeLodLab icon={icon} />
        </section>

        <section className="mb-14">
          <div className="mb-5">
            <h2 className="text-fg-default font-semibold">
              Body × badge harmony directions
            </h2>
            <p className="text-fg-muted mt-1 max-w-3xl text-sm">
              Three ways to reconcile the hand-drawn sticky with the badge. 1
              &amp; 2 keep the warm note and restyle the badge; 3 keeps the
              crisp badge and cleans up the note instead.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            {HARMONY_DIRECTIONS.map((d) => (
              <article
                key={d.id}
                className={cn(
                  'overflow-hidden rounded-xl border',
                  d.recommended
                    ? 'border-info ring-info/20 ring-2'
                    : 'border-edge-default',
                )}
              >
                <div
                  className="flex min-h-56 items-center justify-center p-6"
                  style={{
                    background: 'var(--bg-default)',
                    backgroundImage:
                      'radial-gradient(color-mix(in srgb, var(--fg-subtle) 30%, transparent) 1px, transparent 1px)',
                    backgroundSize: '16px 16px',
                  }}
                >
                  <HarmonyStickyCard direction={d.id} />
                </div>
                <div className="bg-surface p-4">
                  <div className="flex items-center gap-2">
                    <h3 className="text-fg-default text-sm font-semibold">
                      {d.label}
                    </h3>
                    {d.recommended ? (
                      <span className="bg-info-bg text-info rounded-full px-1.5 py-0.5 text-[10px] font-semibold">
                        Recommended
                      </span>
                    ) : null}
                  </div>
                  <p className="text-fg-muted mt-1 text-xs leading-relaxed">
                    {d.note}
                  </p>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="mb-14">
          <div className="mb-5">
            <h2 className="text-fg-default font-semibold">
              Built-in · Huabu star — Chat vs Agent
            </h2>
            <p className="text-fg-muted mt-1 max-w-3xl text-sm">
              A single Huabu-blue identity, no corner badge. Chat has a hollow
              open (talking) mouth; Agent shows a little cursor — it acts on the
              canvas rather than talks. Shown static and running (body wobble);
              the dimmed tile is an external agent for scale reference.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {[
              { label: 'Static', motion: 'none' as AgentIconMotion },
              {
                label: 'Running (body wobble)',
                motion: 'working' as AgentIconMotion,
              },
            ].map((row) => (
              <article
                key={row.label}
                className="border-edge-default bg-surface rounded-lg border p-4"
              >
                <div className="flex h-20 items-center justify-center gap-6">
                  <div className="flex flex-col items-center gap-1.5">
                    <BuiltInStarBody mode="ask" size={52} motion={row.motion} />
                    <span className="text-fg-subtle text-[10px]">Chat</span>
                  </div>
                  <div className="flex flex-col items-center gap-1.5">
                    <BuiltInStarBody
                      mode="operate"
                      size={52}
                      motion={row.motion}
                    />
                    <span className="text-fg-subtle text-[10px]">Agent</span>
                  </div>
                  <div className="flex flex-col items-center gap-1.5 opacity-60">
                    <AgentIcon
                      shape="cloud"
                      color="red"
                      size={52}
                      withFace
                      motion={row.motion}
                    />
                    <span className="text-fg-subtle text-[10px]">External</span>
                  </div>
                </div>
                <h3 className="text-fg-default mt-3 text-sm font-semibold">
                  {row.label}
                </h3>
              </article>
            ))}
          </div>
        </section>

        <section className="mb-14">
          <div className="mb-5">
            <h2 className="text-fg-default font-semibold">
              Built-in · face candidates
            </h2>
            <p className="text-fg-muted mt-1 max-w-3xl text-sm">
              More faces to pick from — Chat leads with a bigger, expressive
              mouth; Agent adds little hands (it acts on the canvas). Pick one
              face per mode.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
            {BUILT_IN_FACE_VARIANTS.map((v) => (
              <article
                key={v.face}
                className="border-edge-default bg-surface flex flex-col items-center gap-2 rounded-lg border p-4"
              >
                <BuiltInStarBody
                  mode={v.group === 'Agent' ? 'operate' : 'ask'}
                  face={v.face}
                  size={56}
                />
                <span className="text-fg-default text-center text-xs font-semibold">
                  {v.label}
                </span>
                <span className="text-fg-subtle text-[10px]">{v.group}</span>
              </article>
            ))}
          </div>
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
