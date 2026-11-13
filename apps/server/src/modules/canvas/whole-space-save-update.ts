// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * What a whole-Space save (`PUT /api/canvas/:id`) tells subscribed pages.
 *
 * Current pages do not send that request: they edit through `execute`,
 * whose commits are published as `update` events, and they follow the Space
 * version through those events only. An older page (or an un-upgraded
 * desktop app) still saves the whole Space, which advances the version with
 * no `update`. A current page then showed none of that page's edits, and
 * took the next commit for a gap: it loaded the Space again and dropped its
 * undo history.
 *
 * The save is therefore published as the `update` it amounts to: the
 * difference between the stored state before and after it, as the same
 * entity deltas and sibling-order events a command batch produces. The
 * request is accepted only at the current version, so the difference is
 * exactly what that client changed, and a current page applies it per
 * property like any other page's edit — keeping what it has not had
 * confirmed itself.
 *
 * Stored state holds no node content (bodies live in sidecars), and the
 * save does not write any. The nodes in the deltas are given their stored
 * content all the same, as a command batch's are: an older page applies an
 * `update` by replacing whole nodes, and a node without its body would
 * blank that page's copy. Both sides of a replaced node get the same
 * content, so the delta says nothing changed there.
 */

import {
  diffCanvasState,
  diffSiblingOrderEvents,
  SiblingOrderReplayError,
  stripTransientEdgeFields,
  stripTransientNodeFields,
} from '@huabu/shared/canvas-engine';

import type { CanvasSyncEvent } from '@huabu/shared';
import type { CanvasEdge, CanvasNode } from '@huabu/shared/canvas-engine';

interface SavedState {
  version: number;
  title: string | null;
  nodes: readonly unknown[];
  edges: readonly unknown[];
}

/**
 * The `update` for a whole-Space save that took the Space from `previous`
 * to `saved`.
 *
 * @param hydrate Returns the given nodes with their stored content; called
 *   once, with the nodes the save inserted or changed.
 */
export async function wholeSpaceSaveUpdate(
  previous: SavedState,
  saved: SavedState,
  hydrate: (nodes: readonly CanvasNode[]) => Promise<CanvasNode[]>,
): Promise<CanvasSyncEvent> {
  // A page's own view flags (selection, measurement) are not the Space's.
  const view = (state: SavedState) => ({
    nodes: (state.nodes as CanvasNode[]).map(stripTransientNodeFields),
    edges: (state.edges as CanvasEdge[]).map(stripTransientEdgeFields),
  });
  const before = view(previous);
  const after = view(saved);
  const slimDeltas = diffCanvasState(before, after);
  const touched = slimDeltas.flatMap((delta) =>
    delta.type === 'INSERT_NODE'
      ? [delta.node]
      : delta.type === 'REPLACE_NODE'
        ? [delta.prev, delta.next]
        : [],
  );
  const hydrated = touched.length > 0 ? await hydrate(touched) : [];
  const withContent = new Map(
    touched.map((node, index) => [node, hydrated[index] ?? node]),
  );
  const full = (node: CanvasNode): CanvasNode => withContent.get(node) ?? node;
  const deltas = slimDeltas.map((delta) =>
    delta.type === 'INSERT_NODE'
      ? { ...delta, node: full(delta.node) }
      : delta.type === 'REPLACE_NODE'
        ? { ...delta, prev: full(delta.prev), next: full(delta.next) }
        : delta,
  );
  let orderEvents: ReturnType<typeof diffSiblingOrderEvents> = [];
  try {
    orderEvents = diffSiblingOrderEvents(
      before.nodes,
      after.nodes,
      saved.version,
    );
  } catch (error) {
    // Legacy topology the strict forest check rejects: pages keep their
    // entity-only replay, as for a command batch.
    if (!(error instanceof SiblingOrderReplayError)) throw error;
  }
  return {
    type: 'update',
    data: {
      fromVersion: previous.version,
      toVersion: saved.version,
      deltas,
      pendingEffects: {
        mutatedNodes: deltas.flatMap((delta) =>
          delta.type === 'INSERT_NODE'
            ? [delta.node]
            : delta.type === 'REPLACE_NODE'
              ? [delta.next]
              : [],
        ),
        deletedNodeIds: deltas.flatMap((delta) =>
          delta.type === 'DELETE_NODE' ? [delta.node.id] : [],
        ),
        contentEditedNodeIds: [],
        deferredFitFrameIds: [],
      },
      ...(orderEvents.length > 0 ? { orderEvents } : {}),
      // A person's save: no undo entry or selection change elsewhere.
      source: 'ui',
      ...(saved.title !== previous.title ? { title: saved.title } : {}),
    },
  };
}
