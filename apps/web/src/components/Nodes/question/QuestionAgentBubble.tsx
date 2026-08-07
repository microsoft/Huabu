// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { clsx } from 'clsx';

import type { CSSProperties } from 'react';

/**
 * Rounded speech-bubble outline shared by BOTH question-node agent-mark stages
 * rendered by {@link QuestionTakeoverMark} — the readable corner badge and the
 * zoomed-out collapsed mark. It is the single source of truth for the `open`
 * bubble geometry (path, warm sticker fill, `--question-border` stroke) so the
 * two stages stay pixel-identical and neither re-implements the shape.
 *
 * Sizing and position are owned entirely by the caller
 * ({@link QuestionTakeoverMark} sizes it inline from its live `size`); the
 * `.question-agent-badge-bubble` class carries only the fade-in that eases the
 * bubble in when a node's conversation opens. The `viewBox` keeps the 2px
 * stroke scaling with whatever box the caller gives it.
 */
export function QuestionAgentBubble({
  fill,
  className,
  style,
}: {
  /** Warm sticker fill for the bubble body (from `resolveQuestionBadgeChrome`). */
  fill: string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      className={clsx('overflow-visible', className)}
      style={style}
      viewBox="0 0 44 48"
      aria-hidden
    >
      <path
        d="M22 2C11 2 2 11 2 22c0 8 4.5 14.5 11 18l-4 6 9-4.5c1.3.3 2.6.5 4 .5 11 0 20-9 20-20S33 2 22 2Z"
        fill={fill}
        stroke="var(--question-border)"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}
