// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Which ids a canvas command names.
 *
 * Two questions are answered here, and they are deliberately different:
 *
 * - {@link collectCommandIds} — every node and edge id a command mentions,
 *   for reporting what a batch touched;
 * - {@link commandReadTargets} — the nodes a command *depends on having read*,
 *   for checking a write against the version its author had seen.
 */

import type { CanvasCommand } from '../index.js';

/** Add every node / edge id `command` mentions to the given sets. */
export function collectCommandIds(
  command: CanvasCommand,
  nodeIds: Set<string>,
  edgeIds: Set<string>,
): void {
  switch (command.type) {
    case 'CREATE_NODES':
      for (const node of command.nodes) if (node.id) nodeIds.add(node.id);
      break;
    case 'DELETE_NODES':
    case 'REORDER_NODES':
    case 'ALIGN_NODES':
    case 'DISTRIBUTE_NODES':
      for (const nodeId of command.nodeIds) nodeIds.add(nodeId);
      break;
    case 'MERGE_NODE_DATA':
      for (const patch of command.patches) nodeIds.add(patch.nodeId);
      break;
    case 'SET_NODE_PARENT':
      for (const nodeId of command.nodeIds) nodeIds.add(nodeId);
      if (command.parentId) nodeIds.add(command.parentId);
      break;
    case 'DISSOLVE_FRAME':
    case 'SET_FRAME_LAYOUT':
      nodeIds.add(command.frameId);
      break;
    case 'SET_NODE_GEOMETRY':
      for (const item of command.items) nodeIds.add(item.nodeId);
      break;
    case 'CONNECT_NODES':
      for (const edge of command.edges) {
        nodeIds.add(edge.source);
        nodeIds.add(edge.target);
        if (edge.id) edgeIds.add(edge.id);
      }
      break;
    case 'DISCONNECT_EDGES':
      for (const edge of command.edges) {
        if (typeof edge === 'string') edgeIds.add(edge);
        else {
          nodeIds.add(edge.source);
          nodeIds.add(edge.target);
        }
      }
      break;
    case 'SET_EDGE_STYLE':
      for (const entry of command.edges) {
        if (typeof entry.edge === 'string') edgeIds.add(entry.edge);
        else {
          nodeIds.add(entry.edge.source);
          nodeIds.add(entry.edge.target);
        }
      }
      break;
    case 'SET_NODE_SELECTION':
    case 'SET_NODE_LOCKED':
    case 'CHANGE_NODE_TYPE':
      break;
  }
}

export interface CommandReadTargets {
  /**
   * Nodes the command needs to still be the ones its author read: each must
   * exist, and must not have been created after the author's read version.
   */
  readonly existence: readonly string[];
  /**
   * The subset whose place in the tree the command also depends on: each
   * must not have changed parent after the author's read version. Always a
   * subset of {@link existence}.
   */
  readonly membership: readonly string[];
}

const NO_TARGETS: CommandReadTargets = { existence: [], membership: [] };

function unique(ids: Iterable<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const id of ids) if (typeof id === 'string' && id) out.add(id);
  return [...out];
}

/**
 * The nodes a command's author must have read for the command to mean what
 * they intended.
 *
 * Only ids the command names itself count. Nodes a command reaches
 * indirectly — the descendants a frame carries along when it moves or is
 * deleted, the children a dissolved frame releases, the ancestors the
 * end-of-batch fit pass resizes — are not targets: the author addressed the
 * named node, whatever it currently contains.
 *
 * - `CREATE_NODES`, `CONNECT_NODES`: none. They add; a stale read cannot make
 *   them overwrite anything, and the handlers already validate their
 *   references.
 * - `DISCONNECT_EDGES`, `SET_EDGE_STYLE`: none. They address edges, which
 *   carry no version stamps.
 * - `SET_NODE_SELECTION`, `APPLY_MEASURED_HEIGHT`: none. View state and
 *   renderer measurements tolerate missing nodes by design.
 * - `DELETE_NODES`: `nodeIds` (existence).
 * - `MERGE_NODE_DATA`: every `patches[].nodeId` (existence).
 * - `SET_NODE_LOCKED`: every `items[].nodeId` (existence).
 * - `CHANGE_NODE_TYPE`: `nodeId` (existence).
 * - `DISSOLVE_FRAME`: `frameId` (existence).
 * - `SET_FRAME_LAYOUT`: `frameId`, every `cells[].nodeId`, and every
 *   `placements[]` `nodeId` / `before` / `after` (existence).
 * - `SET_NODE_PARENT`: `nodeIds` (existence + membership) and a non-null
 *   `parentId` (existence only — where the destination frame itself sits
 *   does not change what "put these inside it" means).
 * - `SET_NODE_GEOMETRY`: every `items[].nodeId` (existence + membership).
 * - `REORDER_NODES`: `nodeIds` and the `to.before` / `to.after` reference
 *   node (existence + membership — "before X" is a position among X's
 *   siblings, so it depends on X's parent as much as on the moved nodes').
 * - `ALIGN_NODES`, `DISTRIBUTE_NODES`: `nodeIds` (existence + membership).
 */
export function commandReadTargets(command: CanvasCommand): CommandReadTargets {
  switch (command.type) {
    case 'CREATE_NODES':
    case 'CONNECT_NODES':
    case 'DISCONNECT_EDGES':
    case 'SET_EDGE_STYLE':
    case 'SET_NODE_SELECTION':
    case 'APPLY_MEASURED_HEIGHT':
      return NO_TARGETS;
    case 'DELETE_NODES':
      return { existence: unique(command.nodeIds), membership: [] };
    case 'MERGE_NODE_DATA':
      return {
        existence: unique(command.patches.map((patch) => patch.nodeId)),
        membership: [],
      };
    case 'SET_NODE_LOCKED':
      return {
        existence: unique(command.items.map((item) => item.nodeId)),
        membership: [],
      };
    case 'CHANGE_NODE_TYPE':
      return { existence: unique([command.nodeId]), membership: [] };
    case 'DISSOLVE_FRAME':
      return { existence: unique([command.frameId]), membership: [] };
    case 'SET_FRAME_LAYOUT': {
      const ids: Array<string | undefined> = [command.frameId];
      for (const cell of command.cells ?? []) ids.push(cell.nodeId);
      for (const placement of command.placements ?? []) {
        const named = placement as {
          nodeId?: string;
          before?: string;
          after?: string;
        };
        ids.push(named.nodeId, named.before, named.after);
      }
      return { existence: unique(ids), membership: [] };
    }
    case 'SET_NODE_PARENT': {
      const membership = unique(command.nodeIds);
      return {
        existence: unique([...membership, command.parentId]),
        membership,
      };
    }
    case 'SET_NODE_GEOMETRY': {
      const ids = unique(command.items.map((item) => item.nodeId));
      return { existence: ids, membership: ids };
    }
    case 'REORDER_NODES': {
      const reference =
        typeof command.to === 'object'
          ? 'before' in command.to
            ? command.to.before
            : command.to.after
          : undefined;
      const ids = unique([...command.nodeIds, reference]);
      return { existence: ids, membership: ids };
    }
    case 'ALIGN_NODES':
    case 'DISTRIBUTE_NODES': {
      const ids = unique(command.nodeIds);
      return { existence: ids, membership: ids };
    }
  }
}
