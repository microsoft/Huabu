import {
  AlertTriangle,
  Check,
  Eye,
  Loader,
  MapPin,
  X,
} from 'lucide-react';
import { useState } from 'react';

import {
  AGENT_ICON_COLORS,
  AGENT_ICON_SHAPES,
  AgentIcon,
} from '@/components/Common/AgentIcon';
import { Button } from '@/components/Common/Button';
import { cn } from '@/components/Common/cn';

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

type MotionMode = 'shape' | 'status' | 'off';
type AgentBadgeStatus = Exclude<DemoStatus, 'idle'> | 'open';

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
      'Chat is anchored here, but execution remains idle until the first send.',
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
      'A pulse indicates that a completed answer has not been viewed.',
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
    description: 'Error is expressed outside the avatar color and shape.',
    question: 'Apply the selected optimization.',
    agentName: 'Claude Code',
  },
  {
    status: 'conflict',
    label: 'Done · conflicts',
    description: 'A warning count reports skipped canvas writes.',
    question: 'Refactor the canvas store without losing local edits.',
    agentName: 'GitHub Copilot',
  },
];

const STATUS_META: Record<
  AgentBadgeStatus,
  { icon: LucideIcon; color: string; title: string }
> = {
  open: {
    icon: MapPin,
    color: 'var(--question-border)',
    title: 'Open in Chat · Not started',
  },
  running: { icon: Loader, color: 'var(--info)', title: 'Running' },
  'done-unread': { icon: Check, color: 'var(--success)', title: 'Done' },
  'done-viewed': { icon: Check, color: 'var(--success)', title: 'Done' },
  error: { icon: X, color: 'var(--danger)', title: 'Error' },
  conflict: { icon: Check, color: 'var(--success)', title: 'Done' },
};

function AgentRunBadge({
  icon,
  status,
  agentName,
  expanded,
  motionMode,
}: {
  icon: AgentIconValue;
  status: AgentBadgeStatus;
  agentName: string;
  expanded: boolean;
  motionMode: MotionMode;
}) {
  const meta = STATUS_META[status];
  const StatusIcon = meta.icon;
  const isRunning = status === 'running';
  const isUnread = status === 'done-unread';
  const hasConflict = status === 'conflict';

  return (
    <div
      className={cn(
        'relative inline-flex h-8 items-center rounded-full shadow-sm',
        expanded ? 'gap-1.5 pr-2 pl-1' : 'w-8 justify-center',
        'bg-surface',
      )}
      style={{
        boxShadow: `0 0 0 2px ${meta.color}, 0 2px 7px color-mix(in srgb, ${meta.color} 28%, transparent)`,
        ...(isUnread
          ? {
              animation: 'question-done-pill-wobble 2.4s ease-in-out infinite',
            }
          : {}),
      }}
      title={`${agentName} · ${meta.title}`}
    >
      <AgentIcon
        shape={icon.shape}
        color={icon.color}
        size={24}
        withFace
        motion={isRunning && motionMode === 'shape' ? 'working' : 'none'}
      />
      {expanded ? (
        <span className="text-fg-default max-w-28 truncate text-xs font-semibold">
          {agentName}
        </span>
      ) : null}
      <span
        className="border-surface absolute -right-1.5 -bottom-1.5 flex size-5 items-center justify-center rounded-full border-2 border-solid"
        style={{ backgroundColor: meta.color }}
        aria-label={meta.title}
      >
        <StatusIcon
          size={12}
          color="white"
          strokeWidth={3}
          style={
            isRunning && motionMode === 'status'
              ? { animation: 'question-icon-spin 1.2s linear infinite' }
              : undefined
          }
        />
      </span>
      {hasConflict ? (
        <span className="bg-warning-bg text-warning absolute -top-2 -right-3 flex h-5 min-w-5 items-center justify-center gap-0.5 rounded-full px-1 text-[10px] font-bold shadow-sm">
          <AlertTriangle size={10} />2
        </span>
      ) : null}
    </div>
  );
}

function QuestionNodePreview({
  stateCase,
  icon,
  expandedBadge,
  motionMode,
}: {
  stateCase: StateCase;
  icon: AgentIconValue;
  expandedBadge: boolean;
  motionMode: MotionMode;
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
        motionMode={motionMode}
      />
    ) : status !== 'idle' && agentName ? (
      <AgentRunBadge
        icon={icon}
        status={status}
        agentName={agentName}
        expanded={expandedBadge}
        motionMode={motionMode}
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

export default function AgentNodePlaygroundPage() {
  const [shape, setShape] = useState<AgentIconShape>('flower');
  const [color, setColor] = useState<AgentIconColor>('blue');
  const [expandedBadge, setExpandedBadge] = useState(false);
  const [motionMode, setMotionMode] = useState<MotionMode>('shape');
  const icon = { shape, color };

  return (
    <div className="bg-bg-default h-full overflow-auto">
      <header className="border-edge-default bg-bg-default/95 sticky top-0 z-20 flex flex-wrap items-center justify-between gap-4 border-b px-6 py-3 backdrop-blur-sm">
        <div>
          <h1 className="text-fg-default text-lg font-semibold">
            Agent × Question Node playground
          </h1>
          <p className="text-fg-muted text-xs">
            Identity stays in the avatar; execution state stays in the semantic
            ring and status dot.
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
          <div className="border-edge-default flex items-center gap-1 border-l pl-4">
            <ChoiceButton
              value="shape"
              selected={motionMode === 'shape'}
              onSelect={setMotionMode}
            >
              Shape motion
            </ChoiceButton>
            <ChoiceButton
              value="status"
              selected={motionMode === 'status'}
              onSelect={setMotionMode}
            >
              Status motion
            </ChoiceButton>
            <ChoiceButton
              value="off"
              selected={motionMode === 'off'}
              onSelect={setMotionMode}
            >
              Motion off
            </ChoiceButton>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        <section className="grid grid-cols-1 gap-x-8 gap-y-12 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {STATE_CASES.map((stateCase) => (
            <QuestionNodePreview
              key={stateCase.label}
              stateCase={stateCase}
              icon={icon}
              expandedBadge={expandedBadge}
              motionMode={motionMode}
            />
          ))}
        </section>

        <section className="border-edge-default bg-surface mt-12 rounded-xl border p-5">
          <div className="flex flex-wrap items-start justify-between gap-5">
            <div className="max-w-xl">
              <h2 className="text-fg-default font-semibold">
                Proposed visual contract
              </h2>
              <p className="text-fg-muted mt-1 text-sm leading-relaxed">
                Profile shape and color identify the agent. The outer ring and
                corner glyph identify runtime state, so a red profile never
                accidentally means failure. Opening a conversation is not an
                execution state, so its badge keeps the selected Agent avatar
                and uses a neutral anchor corner marker instead of a runtime
                status. The Question Node surface itself stays unchanged across
                states.
              </p>
            </div>
            <div className="flex flex-wrap gap-5 text-xs">
              <LegendItem
                icon={Eye}
                label="Unread pulses"
                color="var(--success)"
              />
              <LegendItem
                icon={Loader}
                label="Running spins"
                color="var(--info)"
              />
              <LegendItem
                icon={X}
                label="Error is external"
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
