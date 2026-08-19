// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { fitFrames } from './fit.js';
import { getFrameSizing } from './sizing.js';
import { applyStructuredFrameRelayout } from '../autoLayout/gridLayout.js';
import { indexById, type NestableNode } from '../container/tree.js';

import type { Edge } from '@xyflow/react';

export interface AffectedFrameProjection {
  nodes: NestableNode[];
  affectedFrameIds: Set<string>;
}

/**
 * Project the final geometry of affected Frames and their ancestor chain.
 *
 * Callers supply a tree whose parent membership already represents the future
 * transaction. Free/Hug Frames fit deepest-first, then structured ancestors
 * relayout deepest-first against those fitted child footprints.
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

  const hugFrameIds = [...affectedFrameIds].filter(
    (id) => getFrameSizing(byId.get(id)) === 'hug',
  );
  const fitted = fitFrames(nodes, hugFrameIds);
  const relaid = applyStructuredFrameRelayout(
    fitted,
    affectedFrameIds,
    undefined,
    { edges },
  ).nodes as NestableNode[];

  return { nodes: relaid, affectedFrameIds };
}
