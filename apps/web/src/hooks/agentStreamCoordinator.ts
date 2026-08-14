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
}

const claims = new Map<string, ActiveClaim>();

function claimKey(canvasId: string, threadId: string): string {
  return `${canvasId}\0${threadId}`;
}

export function claimAgentStream(
  canvasId: string,
  threadId: string,
  owner: StreamOwner,
): AgentStreamClaim | null {
  const key = claimKey(canvasId, threadId);
  if (claims.has(key)) return null;

  const active: ActiveClaim = {
    owner,
    controller: new AbortController(),
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
  claims.delete(claimKey(canvasId, threadId));
  active.controller.abort();
}
