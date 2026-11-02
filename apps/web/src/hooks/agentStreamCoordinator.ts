// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

type StreamOwner = 'post' | 'attach';

export interface AgentStreamClaim {
  readonly canvasId: string;
  readonly threadId: string;
  readonly owner: StreamOwner;
  readonly signal: AbortSignal;
  release: () => void;
}

interface ActiveClaim {
  owner: StreamOwner;
  controller: AbortController;
  holdUntilRelease: boolean;
}

const claims = new Map<string, ActiveClaim>();
const releaseListeners = new Map<string, Set<() => void>>();

function claimKey(canvasId: string, threadId: string): string {
  return `${canvasId}\0${threadId}`;
}

export function subscribeAgentStreamRelease(
  canvasId: string,
  threadId: string,
  listener: () => void,
): () => void {
  const key = claimKey(canvasId, threadId);
  const listeners = releaseListeners.get(key) ?? new Set<() => void>();
  listeners.add(listener);
  releaseListeners.set(key, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) releaseListeners.delete(key);
  };
}

function notifyReleased(key: string): void {
  for (const listener of releaseListeners.get(key) ?? []) listener();
}

export function claimAgentStream(
  canvasId: string,
  threadId: string,
  owner: StreamOwner,
  options?: { holdUntilRelease?: boolean },
): AgentStreamClaim | null {
  const key = claimKey(canvasId, threadId);
  if (claims.has(key)) return null;

  const active: ActiveClaim = {
    owner,
    controller: new AbortController(),
    holdUntilRelease: options?.holdUntilRelease ?? false,
  };
  claims.set(key, active);

  return {
    canvasId,
    threadId,
    owner,
    signal: active.controller.signal,
    release: () => {
      if (claims.get(key) !== active) return;
      claims.delete(key);
      active.controller.abort();
      notifyReleased(key);
    },
  };
}

export function hasAgentStreamClaim(
  canvasId: string,
  threadId: string,
): boolean {
  return claims.has(claimKey(canvasId, threadId));
}

export function abortAgentStreamClaim(
  canvasId: string,
  threadId: string,
): void {
  const active = claims.get(claimKey(canvasId, threadId));
  if (!active) return;
  if (!active.holdUntilRelease) claims.delete(claimKey(canvasId, threadId));
  active.controller.abort();
  if (!active.holdUntilRelease) notifyReleased(claimKey(canvasId, threadId));
}
