// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { RfsInkIntentResponse } from '@huabu/shared';

const activeTurns = new Map<
  string,
  {
    count: number;
    ownerNodeId?: string;
    invocationToken?: string;
    onReport?: (result: RfsInkIntentResponse) => void;
  }
>();

function key(canvasId: string, threadId: string): string {
  return `${canvasId}\0${threadId}`;
}

export function beginActiveInkIntentTurn(
  canvasId: string,
  threadId: string,
  ownerNodeId?: string,
  invocationToken?: string,
  onReport?: (result: RfsInkIntentResponse) => void,
): () => void {
  const turnKey = key(canvasId, threadId);
  const current = activeTurns.get(turnKey);
  activeTurns.set(turnKey, {
    count: (current?.count ?? 0) + 1,
    ownerNodeId: ownerNodeId ?? current?.ownerNodeId,
    invocationToken,
    onReport,
  });
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    const active = activeTurns.get(turnKey);
    const remaining = (active?.count ?? 1) - 1;
    if (remaining > 0)
      activeTurns.set(turnKey, { ...active, count: remaining });
    else activeTurns.delete(turnKey);
  };
}

export function publishExternalInkReport(
  canvasId: string,
  threadId: string,
  invocationToken: string,
  result: RfsInkIntentResponse,
): void {
  const active = activeTurns.get(key(canvasId, threadId));
  if (active?.invocationToken === invocationToken) active.onReport?.(result);
}

export function isActiveExternalInkIntentTurn(
  canvasId: string,
  threadId: string,
  invocationToken: string,
): boolean {
  return (
    activeTurns.get(key(canvasId, threadId))?.invocationToken ===
    invocationToken
  );
}

export function isActiveInkIntentTurn(
  canvasId: string,
  threadId: string,
): boolean {
  return activeTurns.has(key(canvasId, threadId));
}

export function activeInkIntentOwnerNodeId(
  canvasId: string,
  threadId: string,
): string | undefined {
  return activeTurns.get(key(canvasId, threadId))?.ownerNodeId;
}
