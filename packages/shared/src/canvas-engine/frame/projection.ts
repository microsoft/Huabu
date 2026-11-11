// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { fitFrameToChildren } from './fit.js';
import { getFrameSizing } from './sizing.js';
import { applyStructuredFrameRelayout } from '../autoLayout/gridLayout.js';
import {
  getAncestorIds,
  indexById,
  type NestableNode,
} from '../container/tree.js';

import type { Edge } from '@xyflow/react';

export interface AffectedFrameProjection {
  nodes: NestableNode[];
  affectedFrameIds: Set<string>;
}

/**
 * Project the final geometry of affected Frames and their ancestor chain.
 *
 * Callers supply a tree whose parent membership already represents the future
 * transaction. Each Frame completes its own layout deepest-first, so mixed
 * free/structured ancestors always consume the final child footprint.
 */
export function projectAffectedFrameGeometry(
  nodes: NestableNode[],
  seedFrameIds: Iterable<string>,
  edges: readonly Edge[] = [],
): AffectedFrameProjection {
  const byId = indexById(nodes);
  const affectedFrameIds = new Set<string>();
  for (const seedId of seedFrameIds) {
    let frameId: string | undefined = seedId;
    while (frameId && !affectedFrameIds.has(frameId)) {
      const frame = byId.get(frameId);
      if (!frame) break;
      affectedFrameIds.add(frameId);
      frameId = frame.parentId;
    }
  }

  if (affectedFrameIds.size === 0) {
    return { nodes, affectedFrameIds };
  }

  const ordered = [...affectedFrameIds]
    .map((id) => ({ id, depth: getAncestorIds(byId, id).length }))
    .sort((a, b) => b.depth - a.depth);
  let projected = nodes;
  for (const { id } of ordered) {
    const structured = applyStructuredFrameRelayout(
      projected,
      [id],
      undefined,
      { edges },
    );
    projected = structured.nodes;
    if (
      !structured.handledFrameIds.has(id) &&
      getFrameSizing(byId.get(id)) === 'hug'
    ) {
      projected = fitFrameToChildren(projected, id);
    }
  }

  return { nodes: projected, affectedFrameIds };
}
