// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * What the server says about node content with a committed batch, for tests
 * that play the server: the stored revision of every node whose saved
 * content the batch created or changed (`nodeContentRevisions`). Mirrors
 * `contentChangedNodeIds` and the sidecar record of `canvas-executor.ts`.
 */

import deepEqual from 'fast-deep-equal';

import { nodeRevisionOf, type Delta } from '@huabu/shared/canvas-engine';

import {
  MD_BACKED_NODE_TYPES,
  NODE_CONTENT_KEYS,
  TEXT_BEARING_NODE_TYPES,
} from '../../save/nodeContentFields';

interface NodeLike {
  id: string;
  type?: string;
  data?: Record<string, unknown>;
}

/** The revision of the sidecar the server writes for `node`. */
export function storedContentRevision(node: NodeLike): string {
  const data = node.data ?? {};
  const type = node.type ?? '';
  return nodeRevisionOf({
    type,
    content:
      TEXT_BEARING_NODE_TYPES.has(type) && typeof data['content'] === 'string'
        ? data['content']
        : '',
    ...(typeof data['src'] === 'string' ? { src: data['src'] } : {}),
    properties: data['properties'],
    propertyDisplayKeys: data['propertyDisplayKeys'],
  });
}

/** The `nodeContentRevisions` the server attaches to a batch of `deltas`. */
export function contentRevisionsOf(
  deltas: readonly Delta[],
): Record<string, string> | undefined {
  const revisions: Record<string, string> = {};
  for (const delta of deltas) {
    if (delta.type === 'INSERT_NODE') {
      const node = delta.node as unknown as NodeLike;
      if (MD_BACKED_NODE_TYPES.has(node.type ?? ''))
        revisions[node.id] = storedContentRevision(node);
    } else if (delta.type === 'REPLACE_NODE') {
      const next = delta.next as unknown as NodeLike;
      if (!MD_BACKED_NODE_TYPES.has(next.type ?? '')) continue;
      const before = (delta.prev.data ?? {}) as Record<string, unknown>;
      const after = next.data ?? {};
      if (
        [...NODE_CONTENT_KEYS].some(
          (key) => !deepEqual(before[key], after[key]),
        )
      )
        revisions[next.id] = storedContentRevision(next);
    }
  }
  return Object.keys(revisions).length > 0 ? revisions : undefined;
}
