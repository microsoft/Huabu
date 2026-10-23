// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { CanvasSummary } from '@huabu/shared';

type ParentSummary = Pick<CanvasSummary, 'parentSpaceId'>;
type LinkNode = { type?: string; data: Record<string, unknown> };

/** Compare identity only; geometry and content edits do not affect ownership. */
export function changedSpaceEntries<T extends LinkNode & { id: string }>(
  previous: readonly T[],
  next: readonly T[],
): T[] {
  const byId = new Map(next.map((node) => [node.id, node]));
  return previous.filter((node) => {
    if (node.type !== 'spacePreview') return false;
    const after = byId.get(node.id);
    return (
      after?.type !== 'spacePreview' ||
      after.data.targetCanvasId !== node.data.targetCanvasId
    );
  });
}

export function isVisibleWorldNode(
  node: LinkNode,
  canvasId: string,
  worldId: string | null,
  summaries: Record<string, ParentSummary | undefined>,
): boolean {
  if (canvasId !== worldId || node.type !== 'spacePreview') return true;
  const target = node.data.targetCanvasId;
  if (typeof target !== 'string') return true;
  const summary = summaries[target];
  return summary !== undefined && !summary.parentSpaceId;
}

export const REQUEST_DELETE_SPACE = 'huabu:request-delete-space';
export const REQUEST_REPARENT_SPACE = 'huabu:request-reparent-space';

export function spaceAncestorIds(
  canvasId: string,
  summaries: Record<string, ParentSummary | undefined>,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  let id: string | null = canvasId;
  while (id && !seen.has(id)) {
    seen.add(id);
    result.unshift(id);
    id = summaries[id]?.parentSpaceId ?? null;
  }
  return result;
}
