// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Field-level application of a server update.
 *
 * An in-place edit arrives as a `REPLACE_NODE` that names the fields the
 * batch changed, with their previous and new values. {@link expandNodeRows}
 * merges such a row into the live local node (the shared applier,
 * `mergeNodeFields`), giving the node before and after the change as this
 * page would hold it. This module then rewrites each row against the live
 * local entity so that only the property units the update actually changed
 * are written, and units held by an unconfirmed local change are left alone
 * and reported as withheld.
 *
 * The output is still a `Delta[]`, so the existing replay
 * (`applyDeltas`, dirty-content protection, order replay) runs unchanged on
 * top of it. When the local node equals the delta's `prev` and nothing is
 * held, the rewritten delta produces exactly the delta's `next`.
 *
 * Pure functions only.
 */

import { mergeNodeFields } from '@huabu/shared/canvas-engine';

import {
  EXISTENCE_UNIT,
  edgeKey,
  nodeUnitKey,
  type WithheldUnit,
} from './inFlight';
import {
  applyUnits,
  changedUnits,
  readUnit,
  type UnitNode,
} from './propertyUnits';

import type { CanvasNode, Delta } from '@huabu/shared/canvas-engine';

/**
 * Give every node row the whole node it is about, as this page holds it.
 *
 * A `REPLACE_NODE` names only the fields that changed. Merged into the live
 * local node it becomes `prev` = that node with the fields' previous values
 * and `next` = that node with their new values, so everything downstream
 * reads whole nodes and the two differ in exactly what the batch changed. A
 * `DELETE_NODE` carries an id; it is given the local node. A row for a node
 * this page does not have is left as it is — nothing is applied for it.
 */
export function expandNodeRows(
  deltas: readonly Delta[],
  localNodes: readonly { id: string }[],
): Delta[] {
  const local = new Map(localNodes.map((node) => [node.id, node]));
  return deltas.map((delta): Delta => {
    if (delta.type === 'REPLACE_NODE') {
      const node = local.get(delta.next.id) as CanvasNode | undefined;
      if (!node) return delta;
      return {
        ...delta,
        prev: mergeNodeFields(node, delta.next, delta.prev),
        next: mergeNodeFields(node, delta.prev, delta.next),
      };
    }
    if (delta.type === 'DELETE_NODE') {
      const node = local.get(delta.node.id) as CanvasNode | undefined;
      return node ? { ...delta, node } : delta;
    }
    return delta;
  });
}

type LocalEdge = { id: string } & Record<string, unknown>;

export interface FieldLevelInput {
  deltas: readonly Delta[];
  localNodes: readonly UnitNode[];
  localEdges: readonly LocalEdge[];
  /** Whether an unconfirmed local change holds this in-flight key. */
  isHeld: (key: string) => boolean;
  /**
   * Drop React Flow selection state from nodes and edges the update
   * inserts, so what another person created does not arrive selected on
   * this page.
   */
  stripInsertedSelection?: boolean;
}

export interface FieldLevelResult {
  deltas: Delta[];
  /** Remote node-unit values kept back because the unit is held locally. */
  withheld: WithheldUnit[];
  /** In-flight keys the update changed, held or not. */
  covered: Set<string>;
  /** Ids of `INSERT_NODE` rows, including ones rewritten to a replace. */
  insertedNodeIds: Set<string>;
  /** The server's whole node for every row that names one, keyed by id. */
  serverNodes: Map<string, UnitNode>;
}

type NodeDelta<T extends Delta['type']> = Extract<Delta, { type: T }>;

export function toFieldLevelDeltas(input: FieldLevelInput): FieldLevelResult {
  const { isHeld } = input;
  const nodes = new Map(input.localNodes.map((node) => [node.id, node]));
  const edges = new Map(input.localEdges.map((edge) => [edge.id, edge]));
  const out: Delta[] = [];
  const withheld: WithheldUnit[] = [];
  const covered = new Set<string>();
  const insertedNodeIds = new Set<string>();
  const serverNodes = new Map<string, UnitNode>();

  /** Write the units `next` changes onto the live node, minus held ones. */
  const mergeOntoLocal = (
    local: UnitNode,
    next: UnitNode,
    units: readonly string[],
  ): void => {
    const free: string[] = [];
    for (const unit of units) {
      const key = nodeUnitKey(local.id, unit);
      covered.add(key);
      if (isHeld(key)) {
        withheld.push({
          nodeId: local.id,
          unit,
          value: readUnit(next, unit),
        });
      } else {
        free.push(unit);
      }
    }
    if (free.length === 0) return;
    const merged = applyUnits(local, next, free);
    nodes.set(local.id, merged);
    out.push({
      type: 'REPLACE_NODE',
      prev: local,
      next: merged,
    } as unknown as NodeDelta<'REPLACE_NODE'>);
  };

  for (const delta of input.deltas) {
    switch (delta.type) {
      case 'REPLACE_NODE': {
        const next = delta.next as unknown as UnitNode;
        serverNodes.set(next.id, next);
        const local = nodes.get(next.id);
        // A node this page no longer has (deleted here, delete unconfirmed)
        // stays absent; a rejected delete heals through a reload.
        if (!local) break;
        mergeOntoLocal(
          local,
          next,
          changedUnits(delta.prev as unknown as UnitNode, next),
        );
        break;
      }
      case 'INSERT_NODE': {
        const node = delta.node as unknown as UnitNode;
        insertedNodeIds.add(node.id);
        serverNodes.set(node.id, node);
        covered.add(nodeUnitKey(node.id, EXISTENCE_UNIT));
        const local = nodes.get(node.id);
        if (local) {
          // The optimistic copy of a node this page created: adopt what the
          // server normalized, keep later unconfirmed local changes.
          mergeOntoLocal(local, node, changedUnits(local, node));
          break;
        }
        // Deleted here again before the creation was confirmed.
        if (isHeld(nodeUnitKey(node.id, EXISTENCE_UNIT))) break;
        const inserted = input.stripInsertedSelection
          ? withoutSelection(node)
          : node;
        nodes.set(node.id, inserted);
        out.push({
          type: 'INSERT_NODE',
          node: inserted,
        } as unknown as NodeDelta<'INSERT_NODE'>);
        break;
      }
      case 'DELETE_NODE': {
        covered.add(nodeUnitKey(delta.node.id, EXISTENCE_UNIT));
        nodes.delete(delta.node.id);
        out.push(delta);
        break;
      }
      case 'INSERT_EDGE':
      case 'REPLACE_EDGE': {
        const edge = delta.type === 'INSERT_EDGE' ? delta.edge : delta.next;
        const key = edgeKey(edge.id);
        covered.add(key);
        // Edges are one unit. A held edge keeps its local value; a replace
        // of an edge this page already removed stays removed.
        if (isHeld(key)) break;
        if (delta.type === 'REPLACE_EDGE' && !edges.has(edge.id)) break;
        // Selection is this page's view state and is not in the saved
        // record: the edge the server sends back must not clear it (the
        // update for this page's own resize re-sends a selected edge), and
        // an edge another person created does not arrive selected.
        const localEdge = edges.get(edge.id);
        const placed =
          localEdge || input.stripInsertedSelection
            ? withLocalEdgeSelection(edge as unknown as LocalEdge, localEdge)
            : (edge as unknown as LocalEdge);
        edges.set(edge.id, placed);
        if (placed === (edge as unknown as LocalEdge)) out.push(delta);
        else if (delta.type === 'INSERT_EDGE')
          out.push({ type: 'INSERT_EDGE', edge: placed } as unknown as Delta);
        else out.push({ ...delta, next: placed } as unknown as Delta);
        break;
      }
      case 'DELETE_EDGE': {
        covered.add(edgeKey(delta.edge.id));
        edges.delete(delta.edge.id);
        out.push(delta);
        break;
      }
    }
  }

  return { deltas: out, withheld, covered, insertedNodeIds, serverNodes };
}

function withoutSelection(node: UnitNode): UnitNode {
  if (!('selected' in node) && !('dragging' in node)) return node;
  const { selected: _selected, dragging: _dragging, ...rest } = node;
  return rest as UnitNode;
}

/**
 * The server's edge with this page's own `selected` flag: the local edge's
 * when the page has the edge, none otherwise.
 */
function withLocalEdgeSelection(
  incoming: LocalEdge,
  local: LocalEdge | undefined,
): LocalEdge {
  const selected = local?.selected;
  if (incoming.selected === selected) return incoming;
  const { selected: _selected, ...rest } = incoming;
  return (selected === undefined ? rest : { ...rest, selected }) as LocalEdge;
}
