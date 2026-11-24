// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Workspace-scoped cache of the session-meta snapshots conversations show.
 *
 * Kept apart from `useAcpSessionMeta` so the turn controller can read what a
 * draft is displaying without importing the hook (and the stream it listens to).
 */

import { buildAcpSessionSelectors } from '@huabu/shared';

import { createWorkspaceCache } from './workspaceCache';

import type {
  AcpSessionMetaSnapshot,
  AcpThreadCachedMetaResponse,
  AgentInitialPreferences,
} from '@huabu/shared';

export interface CachedAcpSessionMetaEntry {
  meta: AcpSessionMetaSnapshot;
  source: AcpThreadCachedMetaResponse['source'];
  fetchedAt: number;
}

export const useSessionMetaCache =
  createWorkspaceCache<CachedAcpSessionMetaEntry>();

export function sessionMetaCacheKey(
  canvasId: string | null | undefined,
  threadId: string | null | undefined,
  profileId: string,
): string | null {
  if (!threadId || !profileId) return null;
  return JSON.stringify([canvasId ?? '', threadId, profileId]);
}

/**
 * The model and thought level a conversation with no session yet is showing.
 *
 * Sent with the request that realizes the conversation, so its session starts
 * on what the selectors displayed. `undefined` once the conversation has its
 * own session (the thread owns its selections) or while nothing is shown.
 */
export function readDisplayedInitialPreferences(
  canvasId: string | null | undefined,
  threadId: string | null | undefined,
  profileId: string,
): AgentInitialPreferences | undefined {
  const key = sessionMetaCacheKey(canvasId, threadId, profileId);
  const cached = key ? useSessionMetaCache.getState().get(key) : undefined;
  if (cached?.source !== 'profile') return undefined;
  const selectors = buildAcpSessionSelectors(cached.meta);
  // Mirrors what `AcpSessionSelectors` renders for a Profile observation: the
  // model is always shown, other options only once they carry a selection.
  const model = selectors.find((selector) => selector.category === 'model');
  const thoughtLevel = selectors.find(
    (selector) =>
      selector.category === 'thought_level' && selector.source === 'user',
  );
  const preferences: AgentInitialPreferences = {
    ...(typeof model?.currentValue === 'string' && model.currentValue
      ? { model: model.currentValue }
      : {}),
    ...(typeof thoughtLevel?.currentValue === 'string' &&
    thoughtLevel.currentValue
      ? { thoughtLevel: thoughtLevel.currentValue }
      : {}),
  };
  return Object.keys(preferences).length > 0 ? preferences : undefined;
}
