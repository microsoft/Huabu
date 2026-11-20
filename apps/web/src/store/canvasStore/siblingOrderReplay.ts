// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  applySiblingOrderEvents,
  normalizeTreeOrder,
  SiblingOrderReplayError,
  type CanvasNode,
  type NestableNode,
  type SetSiblingOrderEvent,
} from '@huabu/shared/canvas-engine';

export interface SiblingOrderReplay {
  nodes: NestableNode[];
  /** The events were not installed and a listed parent is not in the server's order. */
  diverged: boolean;
}

/**
 * Install a server commit's sibling paint order over its entity-replayed
 * nodes. Events that do not fit the local forest leave `nextNodes` as they
 * are, which is the entity-only replay a client without order support has.
 *
 * @param prevNodes Local nodes before the commit's deltas were applied.
 * @param nextNodes Local nodes after them, already tree-normalized.
 * @param insertedIds Ids the commit inserts; a local optimistic copy of one
 *   is not part of the prestate the events were recorded against.
 */
export function replaySiblingOrder(
  prevNodes: readonly NestableNode[],
  nextNodes: NestableNode[],
  insertedIds: ReadonlySet<string>,
  events: readonly SetSiblingOrderEvent[],
): SiblingOrderReplay {
  try {
    const ordered = applySiblingOrderEvents(
      prevNodes.filter((node) => !insertedIds.has(node.id)) as CanvasNode[],
      nextNodes as CanvasNode[],
      events,
    );
    return {
      nodes: normalizeTreeOrder(ordered as NestableNode[]),
      diverged: false,
    };
  } catch (error) {
    if (!(error instanceof SiblingOrderReplayError)) throw error;
    const diverged = events.some((event) => {
      const local = nextNodes.filter(
        (node) => (node.parentId ?? null) === event.parentId,
      );
      return (
        !Array.isArray(event.after) ||
        local.length !== event.after.length ||
        local.some((node, index) => node.id !== event.after[index])
      );
    });
    return { nodes: nextNodes, diverged };
  }
}
