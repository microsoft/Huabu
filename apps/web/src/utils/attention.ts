// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { DesktopTabAttention } from '@huabu/shared/desktop-tabs';

/**
 * Something an Agent did that the person has not seen: a turn that ended
 * (`done`), failed (`error`), or waits for their approval (`approval`).
 * Every mark of it — on a Question node, a Preview Tab, a desktop Tab — uses
 * this vocabulary and these colours.
 */
export type AttentionKind = DesktopTabAttention;

/** The one mapping from a kind of attention to its colour. */
export const ATTENTION_COLOR: Record<AttentionKind, string> = {
  done: 'var(--success)',
  error: 'var(--danger)',
  approval: 'var(--warning)',
};

const RANK: Record<AttentionKind, number> = { done: 1, error: 2, approval: 3 };

/** The kind that matters most among several, or null when there is none. */
export function mostPressing(
  kinds: readonly AttentionKind[],
): AttentionKind | null {
  let found: AttentionKind | null = null;
  for (const kind of kinds)
    if (!found || RANK[kind] > RANK[found]) found = kind;
  return found;
}

/**
 * What a conversation holds that the person has not seen. A pending approval
 * comes first; a finished or failed turn counts until it has been viewed.
 */
export function conversationAttention(
  status: 'idle' | 'running' | 'done' | 'error',
  viewed: boolean,
  needsApproval: boolean,
): AttentionKind | null {
  if (needsApproval) return 'approval';
  if (viewed || (status !== 'done' && status !== 'error')) return null;
  return status;
}
