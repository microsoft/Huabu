// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Commands for changes that reached the store without one.
 *
 * Some writers move the store directly: live drag and resize ticks, the
 * preview passes that follow a resize, style patches applied during a
 * gesture, and undo / redo. Their result has to reach the server as
 * commands, so it is read back from the difference between two states.
 *
 * Covered: position, size, a changed parent, non-content `data` keys and
 * `data.style` leaves (set or removed) of nodes present in both states;
 * deleted nodes; nodes present only in the later state, put back whole; a
 * changed sibling order; added and removed edges. Reported as `uncovered`
 * instead: other top-level node fields. Edges whose own fields changed are
 * not seen here.
 *
 * The result is a proposal. Whether running it reproduces the target state
 * is for the caller to check by executing it (see `canvasStore`).
 *
 * Pure functions only.
 */

import {
  stripTransientEdgeFields,
  stripTransientNodeFields,
} from '@huabu/shared/canvas-engine';

import {
  changedUnits,
  PARENT_UNIT,
  POSITION_UNIT,
  readUnit,
  SIZE_UNIT,
  type UnitNode,
} from './propertyUnits';

import type {
  CanvasCommand,
  CanvasEdgeId,
  CanvasNodeId,
  CanvasRestoredEdge,
  CanvasRestoredNode,
} from '@huabu/shared';

type GeometryItem = Extract<
  CanvasCommand,
  { type: 'SET_NODE_GEOMETRY' }
>['items'][number];
type DataPatch = Extract<
  CanvasCommand,
  { type: 'MERGE_NODE_DATA' }
>['patches'][number];

export interface LocalDiffCommands {
  commands: CanvasCommand[];
  /** Changes this module cannot express as a command, as `nodeId:unit`. */
  uncovered: string[];
}

const DATA_STYLE_PREFIX = 'data.style.';
const DATA_PREFIX = 'data.';

function numericSize(
  node: UnitNode,
): { width: number; height?: number } | null {
  const style = node.style as Record<string, unknown> | undefined;
  const width = style?.width;
  if (typeof width !== 'number') return null;
  const height = style?.height;
  return typeof height === 'number' ? { width, height } : { width };
}

/**
 * Commands that take `prev` to `next` for the fields listed above.
 *
 * @param ignoreUnit Units another writer persists (content fields).
 */
export function commandsForLocalDiff(
  prev: readonly UnitNode[],
  next: readonly UnitNode[],
  ignoreUnit: (unit: string) => boolean = () => false,
): LocalDiffCommands {
  const items: GeometryItem[] = [];
  const patches: DataPatch[] = [];
  const uncovered: string[] = [];
  /** New parent id (`''` for the root) → nodes moved under it. */
  const reparented = new Map<string, string[]>();
  if (prev === next) return { commands: [], uncovered };

  const before = new Map(prev.map((node) => [node.id, node]));
  for (const node of next) {
    const start = before.get(node.id);
    if (!start || start === node) continue;
    const units = changedUnits(start, node).filter((u) => !ignoreUnit(u));
    if (units.length === 0) continue;

    const item: { position?: unknown; size?: unknown } = {};
    const patch: Record<string, unknown> = {};
    const style: Record<string, unknown> = {};
    const unset: string[] = [];
    for (const unit of units) {
      if (unit === POSITION_UNIT) {
        item.position = node.position;
      } else if (unit === SIZE_UNIT) {
        const size = numericSize(node);
        if (size) item.size = size;
        else uncovered.push(`${node.id}:${unit}`);
      } else if (unit === PARENT_UNIT) {
        const parentId = (node.parentId as string | undefined) ?? null;
        if (((start.parentId as string | undefined) ?? null) === parentId) {
          uncovered.push(`${node.id}:${unit}`);
        } else {
          const key = parentId ?? '';
          reparented.set(key, [...(reparented.get(key) ?? []), node.id]);
          // The parent change converts the position; state the final one.
          item.position = node.position;
        }
      } else if (unit.startsWith(DATA_STYLE_PREFIX)) {
        const value = readUnit(node, unit);
        if (value.present)
          style[unit.slice(DATA_STYLE_PREFIX.length)] = value.value;
        else unset.push(unit.slice(DATA_PREFIX.length));
      } else if (unit.startsWith(DATA_PREFIX)) {
        const value = readUnit(node, unit);
        if (value.present) patch[unit.slice(DATA_PREFIX.length)] = value.value;
        else unset.push(unit.slice(DATA_PREFIX.length));
      } else {
        uncovered.push(`${node.id}:${unit}`);
      }
    }
    if (Object.keys(style).length > 0) patch.style = style;
    if (item.position !== undefined || item.size !== undefined) {
      items.push({
        nodeId: node.id as CanvasNodeId,
        ...item,
      } as GeometryItem);
    }
    if (Object.keys(patch).length > 0 || unset.length > 0) {
      patches.push({
        nodeId: node.id as CanvasNodeId,
        patch,
        ...(unset.length > 0 ? { unset } : {}),
      } as DataPatch);
    }
  }

  const commands: CanvasCommand[] = [];
  for (const [parentKey, nodeIds] of reparented) {
    commands.push({
      type: 'SET_NODE_PARENT',
      nodeIds: nodeIds as CanvasNodeId[],
      parentId: (parentKey || null) as CanvasNodeId | null,
    });
  }
  if (items.length > 0) commands.push({ type: 'SET_NODE_GEOMETRY', items });
  if (patches.length > 0) commands.push({ type: 'MERGE_NODE_DATA', patches });
  return { commands, uncovered };
}

type DiffEdge = { id: string; source: string; target: string } & Record<
  string,
  unknown
>;

/**
 * Commands that take one whole state to another: {@link commandsForLocalDiff}
 * plus deleted nodes, nodes that come back (`RESTORE_NODES`), sibling order
 * and edges. Used by undo and redo (see `restorePlan.ts`).
 */
export function commandsForStateDiff(
  prev: { nodes: readonly UnitNode[]; edges: readonly DiffEdge[] },
  next: { nodes: readonly UnitNode[]; edges: readonly DiffEdge[] },
  ignoreUnit: (unit: string) => boolean = () => false,
): LocalDiffCommands {
  const commands: CanvasCommand[] = [];
  const uncovered: string[] = [];

  const nextIds = new Set(next.nodes.map((node) => node.id));
  const prevIds = new Set(prev.nodes.map((node) => node.id));
  const created = next.nodes.filter((node) => !prevIds.has(node.id));

  // Edges first: an edge removed together with its node must not be named
  // after the node is gone.
  const nextEdges = new Map(next.edges.map((edge) => [edge.id, edge]));
  const prevEdges = new Map(prev.edges.map((edge) => [edge.id, edge]));
  const removedEdges = prev.edges.filter(
    (edge) =>
      !nextEdges.has(edge.id) &&
      nextIds.has(edge.source) &&
      nextIds.has(edge.target),
  );
  if (removedEdges.length > 0) {
    commands.push({
      type: 'DISCONNECT_EDGES',
      edges: removedEdges.map((edge) => edge.id as CanvasEdgeId),
    });
  }

  const deleted = prev.nodes.filter((node) => !nextIds.has(node.id));
  if (deleted.length > 0) {
    commands.push({
      type: 'DELETE_NODES',
      nodeIds: deleted.map((node) => node.id as CanvasNodeId),
    });
  }

  // A node that comes back is put back whole, as itself.
  if (created.length > 0) {
    commands.push({
      type: 'RESTORE_NODES',
      nodes: created.map(
        (node) => stripTransientNodeFields(node) as CanvasRestoredNode,
      ),
    });
  }

  const survivors = prev.nodes.filter((node) => nextIds.has(node.id));
  const nodeDiff = commandsForLocalDiff(survivors, next.nodes, ignoreUnit);
  commands.push(...nodeDiff.commands);
  uncovered.push(...nodeDiff.uncovered);

  // Paint order is in the node diff above: `data.paintKey` is a node unit.

  // An edge that comes back is put back as it was, handles included,
  // rather than connected and routed anew.
  const addedEdges = next.edges.filter((edge) => !prevEdges.has(edge.id));
  if (addedEdges.length > 0) {
    commands.push({
      type: 'RESTORE_NODES',
      nodes: [],
      edges: addedEdges.map(
        (edge) => stripTransientEdgeFields(edge) as CanvasRestoredEdge,
      ),
    });
  }

  return { commands, uncovered };
}

/**
 * `REORDER_NODES` commands that turn each parent's child order in `prev`
 * into the one in `next`, moving as few nodes as a left-to-right pass needs.
 * Parents whose membership differs are left to the parent commands.
 */
export function reorderCommands(
  prev: readonly UnitNode[],
  next: readonly UnitNode[],
): CanvasCommand[] {
  const childrenOf = (nodes: readonly UnitNode[]) => {
    const byParent = new Map<string, string[]>();
    for (const node of nodes) {
      const key = (node.parentId as string | undefined) ?? '';
      byParent.set(key, [...(byParent.get(key) ?? []), node.id]);
    }
    return byParent;
  };
  // Order is compared after the parent commands ran, i.e. over the
  // membership `next` has.
  const nextParent = new Map(
    next.map((node) => [node.id, (node.parentId as string | undefined) ?? '']),
  );
  const before = childrenOf(
    prev.map((node) => ({
      ...node,
      parentId: nextParent.get(node.id) || undefined,
    })),
  );
  const after = childrenOf(next);
  const commands: CanvasCommand[] = [];
  for (const [parent, target] of after) {
    const working = [...(before.get(parent) ?? [])];
    if (
      working.length !== target.length ||
      !target.every((id) => working.includes(id))
    )
      continue;
    for (let index = 0; index < target.length; index++) {
      const id = target[index];
      if (working[index] === id) continue;
      commands.push({
        type: 'REORDER_NODES',
        nodeIds: [id as CanvasNodeId],
        to:
          index === 0
            ? { before: working[0] as CanvasNodeId }
            : { after: target[index - 1] as CanvasNodeId },
      });
      working.splice(working.indexOf(id), 1);
      working.splice(index, 0, id);
    }
  }
  return commands;
}
