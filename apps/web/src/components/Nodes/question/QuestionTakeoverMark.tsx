// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { clsx } from 'clsx';
import { AlertTriangle, ShieldQuestion } from 'lucide-react';

import './QuestionAgentBadge.css';

import { AgentAvatarMark } from '@/components/Common/AgentAvatarMark.tsx';
import { Tooltip } from '@/components/Common/Tooltip.tsx';
import { MARK_FACE_MIN } from '@/config/nodeTakeover';

import { QuestionAgentBubble } from './QuestionAgentBubble.tsx';
import { resolveQuestionBadgeChrome } from './questionBadgeChrome.ts';

import type { QuestionAgentBadgeStatus } from './questionBadgeChrome.ts';
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
  accessibleLabel?: string;
  tooltip?: ReactNode;
  conflictTooltip?: string;
}

export function resolveQuestionBadgeBackground({
  isIdle,
  isOpen,
  stickerFill,
}: {
  isIdle: boolean;
  isOpen: boolean;
  stickerFill: string;
}): string {
  return isIdle || isOpen ? 'transparent' : stickerFill;
}

export function resolveQuestionSpecialRingGeometry(size: number): {
  inset: number;
  width: number;
} {
  return {
    inset: Math.max(0.5, Math.min(3.5, size / 18)),
    width: Math.max(0.75, Math.min(5, size / 12)),
  };
}

/**
 * `QuestionTakeoverMark` — the single element that IS the question node's agent
 * mark across both discrete zoom stages. It is the SAME sticker badge (warm
 * chip fill, border, status ring, full agent avatar) in both:
 *
 *   readable  → the badge hugs the card's corner, scaling with the card;
 *   collapsed → the identical badge, smaller and centred, standing in for the
 *               whole node once its body is hidden.
 *
 * Keeping the chrome stage-independent means the readable→collapsed transition
 * is a pure move + resize of one unchanged element (no fill/border pop), and
 * the only very-small concession is the inner avatar degrading to a clean solid
 * dot below {@link MARK_FACE_MIN}. `NodeTakeoverLayer` owns where it sits and
 * the transition animation; this component owns only what it looks like at a
 * given `{ stage, size }`. The chip is sized through the
 * `--question-agent-badge-size` CSS variable (the shipped `.question-agent-badge`
 * rule pins width/height to it with `!important`).
 */
export function QuestionTakeoverMark({
  state,
  status,
  agent,
  unread,
  conflictCount,
  interactive,
  onOpen,
  accessibleLabel,
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

  // The badge always keeps its chip border, so leave inner padding (0.8) in
  // both stages — the collapsed mark is the same badge, just smaller.
  const innerSize = Math.round(size * 0.8);

  // Ring/edge thickness scales with the mark so a small collapsed dot doesn't
  // carry a chunky fixed border; clamped so it stays hairline-crisp but never
  // vanishes. (The `open` bubble's SVG stroke already scales via its viewBox.)
  const ringWidth = Math.max(0.75, Math.min(2, size * 0.05));
  const specialRing = resolveQuestionSpecialRingGeometry(size);
  const approvalSatelliteSize = Math.max(12, Math.min(20, size * 0.45));

  // Geometric centring of the `open` bubble.
  // The bubble SVG's viewBox is `0 0 44 48` with the round part a circle
  // centred at (22, 22). Sizing the box to 1.1×/1.2× the mark makes the circle
  // diameter equal the mark (40/44 · 1.1 · size = size), and the circle centre
  // then lands exactly on the chip centre when the box is offset by −0.05·size
  // on BOTH axes:
  //   cx = left + width·(22/44) = −0.05·size + 1.1·size·0.5   = 0.5·size ✓
  //   cy = top  + height·(22/48) = −0.05·size + 1.2·size·0.4583 = 0.5·size ✓
  // So the flex-centred avatar coincides with the circle centre at every zoom,
  // and it stays put across open ↔ read (no optical nudge, no positional pop).
  const bubbleWidth = size * 1.1;
  const bubbleHeight = size * 1.2;
  const bubbleOffset = -size * 0.05;

  // Sticker fill for real agent marks: the collapsed mark is the readable badge
  // with the card body hidden, so it keeps the same background disc + ring. The
  // `open` state is drawn as a chat BUBBLE (a tailed SVG + transparent chip) in
  // BOTH stages, so a collapsed open mark still reads as "conversation" and
  // stays distinct from every other collapsed disc. The EMPTY (idle) mark is
  // just its own identity dot — a chip ring/disc around it only doubles the edge
  // and reads heavy, so idle drops the border, fill and shadow entirely.
  // Otherwise a thin quiet ring (1.5px, lighter than the old 2px) frames it.
  const showBubble = chip.isOpen;
  const chipStyle: CSSProperties = {
    // Drive the sized-with-`!important` container variable; inline width/height
    // is ignored by the `.question-agent-badge` rule.
    ['--question-agent-badge-size' as string]: `${size}px`,
    // Open draws no visible border (the chrome is the bubble), so zero its
    // width too: an absolute child (the bubble) is positioned from the PADDING
    // box, so a non-zero transparent border would push the bubble's circle down
    // -right of the disc/avatar (both centred on the border box). Zeroing it
    // keeps the bubble concentric with the disc and the avatar.
    borderWidth: isIdle || showBubble ? 0 : ringWidth,
    background: resolveQuestionBadgeBackground({
      isIdle,
      isOpen: showBubble,
      stickerFill: chip.stickerFill,
    }),
    borderColor: chip.ringBorderColor,
    boxShadow: isIdle ? 'none' : chip.ringBoxShadow,
    cursor: interactive ? 'pointer' : 'default',
    ['--question-agent-running-ring' as string]: chip.runningRingColor,
    ['--question-agent-special-ring-inset' as string]: `${specialRing.inset}px`,
    ['--question-agent-special-ring-width' as string]: `${specialRing.width}px`,
    ['--question-agent-quiet-ring' as string]:
      'color-mix(in srgb, var(--fg-subtle) 38%, var(--bg-surface))',
  };

  const chipContent = (
    <>
      {showBubble ? (
        <QuestionAgentBubble
          fill={chip.stickerFill}
          className="question-agent-badge-bubble pointer-events-none absolute"
          style={{
            left: bubbleOffset,
            top: bubbleOffset,
            width: bubbleWidth,
            height: bubbleHeight,
          }}
        />
      ) : null}
      {isIdle ? (
        <span
          className="relative z-10 block shrink-0 rounded-full"
          style={{
            width: innerSize,
            height: innerSize,
            background: chip.stickerFill,
            boxShadow: `inset 0 0 0 ${ringWidth}px color-mix(in srgb, var(--question-border) 50%, transparent)`,
          }}
        />
      ) : (
        <span
          className="relative z-10 flex shrink-0 items-center justify-center"
          style={{
            width: innerSize,
            height: innerSize,
          }}
        >
          <AgentAvatarMark
            agent={agent}
            size={innerSize}
            detail={size >= MARK_FACE_MIN ? 'full' : 'dot'}
            motion={chip.isRunning ? 'working' : 'none'}
            className="shrink-0"
          />
        </span>
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
      {chip.isApproval ? (
        <span
          className="bg-warning text-fg-inverse absolute z-20 flex items-center justify-center rounded-full shadow-sm"
          style={{
            width: approvalSatelliteSize,
            height: approvalSatelliteSize,
            top: -approvalSatelliteSize * 0.3,
            right: -approvalSatelliteSize * 0.3,
          }}
        >
          <ShieldQuestion size={approvalSatelliteSize * 0.62} />
        </span>
      ) : null}
    </>
  );
  const chipClassName = clsx(
    'question-agent-badge relative inline-flex items-center justify-center rounded-full border-solid',
    !isIdle && !showBubble && !chip.isRunning && 'shadow-sm',
    chip.isRunning &&
      'question-agent-ring-running border-transparent shadow-none',
    chip.isApproval &&
      'question-agent-ring-approval border-transparent shadow-none',
    chip.isError &&
      chip.needsAttention &&
      'question-agent-ring-error border-transparent',
    chip.needsAttention && !chip.isApproval && 'question-agent-attention',
  );
  const canOpen = interactive && !!onOpen;
  // Deliberately a plain (role-annotated) div, NOT the shared <Button>: Button
  // injects icon-size utilities (`[&_svg]:h-4 w-4`) that clamp the avatar SVG
  // and fight the continuous size-driven mark, breaking the zoom-out stand-in.
  // Keyboard + aria-label give it the same accessibility as a button.
  const chip$ = canOpen ? (
    <div
      role="button"
      tabIndex={0}
      aria-label={accessibleLabel ?? agent.alias}
      className={chipClassName}
      style={chipStyle}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          onOpen();
        }
      }}
    >
      {chipContent}
    </div>
  ) : (
    <div
      className={clsx(chipClassName, 'pointer-events-none')}
      style={chipStyle}
      aria-hidden
    >
      {chipContent}
    </div>
  );

  return tooltip ? <Tooltip content={tooltip}>{chip$}</Tooltip> : chip$;
}
