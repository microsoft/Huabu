// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { NODE_CONTENT_KEYS } from './nodeContentFields';

import type { Delta } from '@huabu/shared/canvas-engine';
import type { Node } from '@xyflow/react';

const DERIVED_DATA_FIELDS = [
  'contentMissing',
  'artifactMissing',
  'contentDuplicate',
  'duplicateFiles',
] as const;

const RUNTIME_NODE_FIELDS = [
  'selected',
  'dragging',
  'measured',
  'resizing',
  'handles',
  'internals',
] as const;

/**
 * Rehydrate canonical slim REPLACE_NODE deltas with fields that the topology
 * publication intentionally omits. Structural fields still come from the
 * server; nodeChanges/invalidations subsequently replace authoritative
 * sidecar fields for records changed by the same commit.
 */
export function overlayLocalFieldsOnStructureDeltas(
  deltas: readonly Delta[],
  currentNodes: readonly Node[],
): Delta[] {
  const currentById = new Map(currentNodes.map((node) => [node.id, node]));
  return deltas.map((delta) => {
    if (delta.type !== 'REPLACE_NODE') return delta;
    const current = currentById.get(delta.next.id);
    if (!current) return delta;

    const next = delta.next as unknown as Node;
    const preservedNodeFields: Record<string, unknown> = {};
    for (const key of RUNTIME_NODE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(current, key)) {
        preservedNodeFields[key] = current[key as keyof Node];
      }
    }

    const currentData = (current.data ?? {}) as Record<string, unknown>;
    const preservedData: Record<string, unknown> = {};
    for (const key of [...NODE_CONTENT_KEYS, ...DERIVED_DATA_FIELDS]) {
      if (Object.prototype.hasOwnProperty.call(currentData, key)) {
        preservedData[key] = currentData[key];
      }
    }

    return {
      ...delta,
      next: {
        ...next,
        ...preservedNodeFields,
        data: {
          ...((next.data ?? {}) as Record<string, unknown>),
          ...preservedData,
        },
      },
    } as Delta;
  });
}
