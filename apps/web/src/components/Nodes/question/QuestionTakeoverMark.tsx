import { clsx } from 'clsx';
import { AlertTriangle } from 'lucide-react';

import './QuestionAgentBadge.css';

import { AgentAvatarMark } from '@/components/Common/AgentAvatarMark.tsx';
import { Tooltip } from '@/components/Common/Tooltip.tsx';
import { MARK_FACE_MIN } from '@/config/nodeTakeover';

import { resolveQuestionBadgeChrome } from './questionBadgeChrome.ts';

import type { QuestionAgentBadgeStatus } from './QuestionAgentBadge.tsx';
import type { TakeoverState } from '@/config/nodeTakeover';
import type { QuestionAgentPresentation } from '@/utils/questionAgentPresentation.ts';
import type { CSSProperties, ReactNode } from 'react';

export interface QuestionTakeoverMarkProps {
  /** Discrete stage + rendered size (screen px) from the engine. */
  state: TakeoverState;
  /** `idle` (never asked) draws a quiet neutral mark: no ring/halo/bubble. */
  status: QuestionAgentBadgeStatus | 'idle';
  agent: QuestionAgentPresentation;
  unread: boolean;
  conflictCount: number;
  /** True once a conversation exists — only then is a single-click meaningful. */
  interactive: boolean;
  onOpen?: () => void;
  tooltip?: ReactNode;
  conflictTooltip?: string;
}

/**
 * `QuestionTakeoverMark` — the single element that IS the question node's agent
 * mark across the three discrete zoom stages:
 *
 *   readable → the corner badge, on a warm "sticker" chip, scaling with the card;
 *   avatar   → a centred agent avatar stand-in (no sticker fill, status ring kept);
 *   dot      → a solid identity dot (the avatar collapses at ~<22px).
 *
 * `NodeTakeoverLayer` owns where it sits and the transition animation; this
 * component owns only what it looks like at a given `{ stage, size }`. The chip
 * is sized through the `--question-agent-badge-size` CSS variable (the shipped
 * `.question-agent-badge` rule pins width/height to it with `!important`).
 */
export function QuestionTakeoverMark({
  state,
  status,
  agent,
  unread,
  conflictCount,
  interactive,
  onOpen,
  tooltip,
  conflictTooltip,
}: QuestionTakeoverMarkProps) {
  const { stage, size } = state;
  const isIdle = status === 'idle';
  const isReadable = stage === 'readable';

  // The mark is only an ABBREVIATED stand-in for the node, shown when the body
  // can't be. A never-asked node whose card is still readable has nothing to
  // abbreviate and no agent status to show — so it renders no corner badge; the
  // sticky-yellow mark only appears once the node collapses (avatar/dot).
  if (isReadable && isIdle) return null;

  const chip = resolveQuestionBadgeChrome({
    status,
    agent,
    unread,
    conflictCount,
  });

  // The readable badge keeps a chip border, so leave inner padding (0.8). The
  // stand-in stages drop the border (below) so the mark can fill the node
  // footprint that edges connect to — give the inner avatar/dot most of that
  // space (0.94) so the icon reaches the edges instead of floating inside them.
  const innerSize = Math.round(size * (isReadable ? 0.8 : 0.94));

  // Sticker fill only in the readable stage (a badge resting on the card). In
  // the avatar/dot stand-in stages the chip background is transparent so a
  // field of zoomed-out nodes reads as clean marks, not pale discs — the status
  // ring (running/error) still conveys state.
  const chipStyle: CSSProperties = {
    // Drive the sized-with-`!important` container variable; inline width/height
    // is ignored by the `.question-agent-badge` rule.
    ['--question-agent-badge-size' as string]: `${size}px`,
    // Drop the 2px chip border outside the readable badge so the chip's content
    // box equals the full mark size (fills the footprint) and small dots stay
    // perfectly round instead of being flex-squished by the border inset.
    borderWidth: isReadable ? undefined : 0,
    background:
      isReadable && !chip.isOpen && !chip.isRunning
        ? chip.stickerFill
        : 'transparent',
    borderColor: chip.ringBorderColor,
    boxShadow: isReadable ? chip.ringBoxShadow : 'none',
    cursor: interactive ? 'pointer' : 'default',
    ['--question-agent-running-ring' as string]: chip.runningRingColor,
    ['--question-agent-quiet-ring' as string]:
      'color-mix(in srgb, var(--fg-subtle) 55%, var(--bg-surface))',
  };

  const chip$ = (
    <div
      className={clsx(
        'question-agent-badge relative inline-flex items-center justify-center rounded-full border-2 border-solid',
        isReadable && !chip.isOpen && !chip.isRunning && 'shadow-sm',
        chip.isRunning &&
          'question-agent-ring-running border-transparent shadow-none',
        chip.isError &&
          chip.needsAttention &&
          'question-agent-ring-error border-transparent',
        chip.needsAttention && 'question-agent-attention',
      )}
      style={chipStyle}
      onClick={
        interactive && onOpen
          ? (e) => {
              e.stopPropagation();
              onOpen();
            }
          : undefined
      }
      aria-hidden
    >
      {isReadable && chip.isOpen ? (
        <svg
          className="pointer-events-none absolute overflow-visible"
          style={{
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
            fill={chip.stickerFill}
            stroke="var(--question-border)"
            strokeWidth="2"
            strokeLinejoin="round"
          />
        </svg>
      ) : null}
      {isIdle ? (
        // Never-asked node: a pale sticky-yellow dot (its own note identity),
        // not an agent colour and not a neutral grey. `shrink-0` so the flex
        // chip never squishes it into an ellipse.
        <span
          className="relative z-10 block shrink-0 rounded-full"
          style={{
            width: innerSize,
            height: innerSize,
            background: chip.stickerFill,
            boxShadow:
              'inset 0 0 0 1.5px color-mix(in srgb, var(--question-border) 50%, transparent)',
          }}
        />
      ) : (
        <AgentAvatarMark
          agent={agent}
          size={innerSize}
          // The readable badge is always the full character. Collapsed stand-ins
          // stay a clean solid dot until the mark is clearly big enough to read
          // a face (MARK_FACE_MIN), so a small mark never renders a muddy
          // icon-that-looks-like-a-dot bigger than a real avatar.
          detail={isReadable ? 'full' : size >= MARK_FACE_MIN ? 'full' : 'dot'}
          motion={chip.isRunning ? 'working' : 'none'}
          className="relative z-10 shrink-0"
        />
      )}
      {isReadable && chip.hasConflict ? (
        <span
          title={conflictTooltip}
          className="bg-warning-bg text-warning absolute -top-2.5 -right-3.5 z-20 flex h-6 min-w-6 items-center justify-center gap-0.5 rounded-full px-1.5 text-[11px] font-bold shadow-sm"
        >
          <AlertTriangle size={12} />
          {conflictCount}
        </span>
      ) : null}
    </div>
  );

  return tooltip ? <Tooltip content={tooltip}>{chip$}</Tooltip> : chip$;
}
