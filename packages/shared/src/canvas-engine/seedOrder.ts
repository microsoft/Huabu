// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Order keys for a Space stored before nodes carried them.
 *
 * Such a Space holds paint order as array position and a Column / Row
 * Frame's reading order as a list on the Frame (`data.layoutOrder`). Reading
 * it gives every node the keys those stand for and drops the list. The
 * result depends only on the stored state, so two reads before the first
 * write agree, and the keys are stored with the Space's next write. A Space
 * that already has its keys comes back unchanged, array included.
 */

import { trackKeyChanges } from './autoLayout/layoutOrder.js';
import { settlePaintOrder } from './container/paintOrder.js';

import type { NestableNode } from './container/tree.js';

/** The tracks a Frame stored as lists of child ids, or `undefined`. */
function storedTracks(node: NestableNode): string[][] | undefined {
  const value = (node.data as Record<string, unknown> | undefined)?.layoutOrder;
  if (!Array.isArray(value)) return undefined;
  return value.map((track) =>
    Array.isArray(track)
      ? track.filter((id): id is string => typeof id === 'string')
      : [],
  );
}

function seedTrackKeys<T extends NestableNode>(nodes: readonly T[]): T[] {
  if (!nodes.some((node) => node.data && 'layoutOrder' in node.data))
    return nodes as T[];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const keys = new Map<string, string>();
  for (const frame of nodes) {
    const tracks = storedTracks(frame);
    if (!tracks) continue;
    // Only what is still a child of this Frame; a listed id may have left.
    const present = tracks.map((track) =>
      track.filter((id) => byId.get(id)?.parentId === frame.id),
    );
    for (const [id, key] of trackKeyChanges(present, byId)) keys.set(id, key);
  }
  return nodes.map((node) => {
    const key = keys.get(node.id);
    if (key === undefined && !(node.data && 'layoutOrder' in node.data))
      return node;
    const { layoutOrder: _layoutOrder, ...data } = node.data as Record<
      string,
      unknown
    >;
    return {
      ...node,
      data: key === undefined ? data : { ...data, trackKey: key },
    };
  });
}

export function seedNodeOrder<T extends NestableNode>(
  nodes: readonly T[],
): T[] {
  return settlePaintOrder(seedTrackKeys(nodes));
}
