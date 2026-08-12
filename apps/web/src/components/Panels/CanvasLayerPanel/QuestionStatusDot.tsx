// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * QuestionStatusDot — small ambient indicator overlaid on a question
 * node's row icon in the Layer Panel.
 *
 * Visibility rules (intentionally minimal so the panel stays scannable):
 *  - `idle`              → not rendered (matches `QuestionNode` itself,
 *                          which only shows its agent badge for
 *                          `status !== 'idle'`).
 *  - `done` + `viewed`   → not rendered (the answer was read; no need
 *                          to keep nagging).
 *  - everything else     → a 6px filled circle in the status color,
 *                          with a tooltip carrying the status wording
 *                          plus the truncated `errorMessage` when
 *                          relevant.
 *
 * The dot is rendered with `pointer-events-auto` so its tooltip works
 * even though its parent `<span>` in `TreeRowItem` is
 * `pointer-events-none` (that span is non-interactive on purpose — the
 * row's click target is the surrounding row, not the icon).
 */

import { Tooltip } from '@/components/Common/Tooltip';

import type { QuestionNodeStatus } from '@huabu/shared';

interface QuestionStatusDotProps {
  status: QuestionNodeStatus;
  viewed?: boolean;
  errorMessage?: string;
}

const ERROR_MESSAGE_MAX = 200;

const STATUS_LABELS: Record<Exclude<QuestionNodeStatus, 'idle'>, string> = {
  running: 'Running',
  done: 'Done',
  error: 'Error',
};

const DOT_COLORS: Record<
  Exclude<QuestionNodeStatus, 'idle'>,
  { bg: string; pulse?: boolean }
> = {
  running: { bg: 'var(--info)' },
  done: { bg: 'var(--success)', pulse: true },
  error: { bg: 'var(--danger)' },
};

function tooltipFor(
  status: Exclude<QuestionNodeStatus, 'idle'>,
  viewed: boolean,
  errorMessage?: string,
): string {
  if (status === 'error') {
    const trimmed = errorMessage?.trim();
    if (trimmed) {
      const clipped =
        trimmed.length > ERROR_MESSAGE_MAX
          ? `${trimmed.slice(0, ERROR_MESSAGE_MAX)}…`
          : trimmed;
      return `Error — ${clipped}`;
    }
    return STATUS_LABELS.error;
  }
  if (status === 'done' && !viewed) {
    return `${STATUS_LABELS.done} · unread`;
  }
  return STATUS_LABELS[status];
}

export const QuestionStatusDot = ({
  status,
  viewed,
  errorMessage,
}: QuestionStatusDotProps) => {
  if (status === 'idle') return null;
  if (status === 'done' && viewed) return null;

  const visual = DOT_COLORS[status];
  const tooltip = tooltipFor(status, Boolean(viewed), errorMessage);

  return (
    <Tooltip
      content={tooltip}
      wrapperClassName="pointer-events-auto absolute -right-0.5 -bottom-0.5 inline-flex h-1.5 w-1.5"
    >
      <span
        aria-label={tooltip}
        role="status"
        className={`block h-full w-full rounded-full ${
          visual.pulse ? 'animate-pulse' : ''
        }`}
        style={{ backgroundColor: visual.bg }}
      />
    </Tooltip>
  );
};
