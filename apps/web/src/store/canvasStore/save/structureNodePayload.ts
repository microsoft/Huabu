// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { NODE_CONTENT_KEYS } from './nodeContentFields';

import type { Node } from '@xyflow/react';

/**
 * Build the node payload for a structure PUT.
 *
 * Existing nodes omit markdown-sidecar fields because those are committed by
 * the per-node queue. A queue-tracked new node is different: its topology and
 * initial sidecar must appear atomically, so those fields ride its first
 * structure request and are stripped from every later one.
 */
export function stripNodeContentForStructurePut(
  nodes: readonly Node[],
  preserveContentNodeIds: ReadonlySet<string> = new Set(),
): Node[] {
  return nodes.map((node) => {
    if (preserveContentNodeIds.has(node.id)) return node;
    const data = node.data;
    if (!data) return node;
    let mutated = false;
    const slim: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (NODE_CONTENT_KEYS.has(key)) {
        mutated = true;
        continue;
      }
      slim[key] = value;
    }
    return mutated ? { ...node, data: slim } : node;
  });
}
