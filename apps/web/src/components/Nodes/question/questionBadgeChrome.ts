// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Question node agent status the mark renders. `idle` (never asked) is handled
 * separately by callers; these five are the states that produce a visible
 * chip/mark.
 */
export type QuestionAgentBadgeStatus =
  | 'open'
  | 'running'
  | 'approval'
  | 'done'
  | 'error';

/**
 * Resolved status and attention color for a question node's agent mark.
 *
 * Shared by the readable corner badge and the zoomed-out collapsed mark (both
 * rendered by {@link QuestionTakeoverMark}) so status reads identically across
 * the whole zoom range; this is the single source of truth for status → colour
 * mapping.
 */
export interface QuestionBadgeChrome {
  isOpen: boolean;
  isRunning: boolean;
  isApproval: boolean;
  isError: boolean;
  hasConflict: boolean;
  /** Any blocking request or unviewed terminal outcome needing attention. */
  needsAttention: boolean;
  attentionColor: string;
}

export function resolveQuestionBadgeChrome({
  status,
  unread,
  conflictCount,
}: {
  // `idle` (never asked) has no corner badge, but the zoomed-out stand-in
  // still shows the agent identity quietly — it maps to the same quiet ring as
  // a viewed answer (no halo, no bubble).
  status: QuestionAgentBadgeStatus | 'idle';
  unread: boolean;
  conflictCount: number;
}): QuestionBadgeChrome {
  const isOpen = status === 'open';
  const isRunning = status === 'running';
  const isApproval = status === 'approval';
  const isError = status === 'error';
  const hasConflict = conflictCount > 0;
  // Any unviewed terminal outcome wants attention: a done-unread answer, an
  // (unviewed) error, or skipped-write conflicts.
  const needsAttention = isApproval || unread || hasConflict;
  const attentionColor = isApproval
    ? 'var(--warning)'
    : isError
      ? 'var(--danger)'
      : hasConflict
        ? 'var(--warning)'
        : 'var(--success)';

  return {
    isOpen,
    isRunning,
    isApproval,
    isError,
    hasConflict,
    needsAttention,
    attentionColor,
  };
}
