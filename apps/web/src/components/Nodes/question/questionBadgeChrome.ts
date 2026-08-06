// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { agentIconColorHex } from '@/components/Common/AgentIcon';

import type { QuestionAgentPresentation } from '@/utils/questionAgentPresentation';

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
 * Resolved visual chrome for a question node's agent status mark — the ring
 * colour, attention halo, running-ring identity colour, and sticker fill.
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
  /** Identity colour the running sweep echoes. */
  runningRingColor: string;
  ringBorderColor: string;
  ringBoxShadow: string;
  stickerFill: string;
}

export function resolveQuestionBadgeChrome({
  status,
  agent,
  unread,
  conflictCount,
}: {
  // `idle` (never asked) has no corner badge, but the zoomed-out stand-in
  // still shows the agent identity quietly — it maps to the same quiet ring as
  // a viewed answer (no halo, no bubble).
  status: QuestionAgentBadgeStatus | 'idle';
  agent: QuestionAgentPresentation;
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
  if (isOpen || isRunning || isApproval) {
    ringBorderColor = 'transparent';
    if (isApproval) {
      ringBoxShadow = `0 0 0 3px color-mix(in srgb, ${attentionColor} 24%, transparent), 0 0 12px 2px color-mix(in srgb, ${attentionColor} 34%, transparent)`;
    }
  } else if (needsAttention) {
    ringBoxShadow = `0 0 0 3px color-mix(in srgb, ${attentionColor} 26%, transparent), 0 0 12px 2px color-mix(in srgb, ${attentionColor} 42%, transparent)`;
    ringBorderColor = isError ? 'transparent' : attentionColor;
  }

  // Warm off-white "sticker" fill, shared by the chip body and the open chat
  // bubble so the badge reads like a little sticker resting on the note.
  const stickerFill = 'color-mix(in srgb, var(--question-bg) 32%, white)';

  return {
    isOpen,
    isRunning,
    isApproval,
    isError,
    hasConflict,
    needsAttention,
    attentionColor,
    runningRingColor,
    ringBorderColor,
    ringBoxShadow,
    stickerFill,
  };
}
