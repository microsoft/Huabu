// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `RESTORE_NODES` — put nodes and edges back as a page's undo history holds
 * them.
 *
 * Every other command states an intent and lets the engine derive the
 * result. An undo already has the result: the node exactly as it was,
 * with its id, its content and its place in the tree. This command installs
 * that, so a deleted node can come back as itself instead of as a new
 * creation.
 *
 * - A node whose id is not listed in `replace` is inserted and must not
 *   exist. A node listed in `replace` must exist and is replaced in place.
 * - An edge is inserted, or replaces the edge with the same id.
 *
 * The command is all-or-nothing: one item that is not admitted refuses the
 * whole command. It is UI-only — not in the agent schema, and refused for
 * an `agent` batch before it gets here (`commandScope.ts`) — because only a
 * page's own history can vouch for the snapshot.
 *
 * It fits no Frame and reroutes no edge: the snapshot is the state to
 * reach, not a starting point.
 */

import { noop, type CommandDefinition } from './types.js';
import { preserveAgentNodeOwnedData } from '../agentNodeOwnership.js';
import { isContainerNode } from '../container/policy.js';
import { stripTransientEdgeFields, stripTransientNodeFields } from '../diff.js';
import { measuredSizeKey, readMeasuredSizeHint } from '../height/freshness.js';

import type { CanvasCommand } from '../../index.js';
import type { Edge, Node } from '@xyflow/react';

type Cmd = Extract<CanvasCommand, { type: 'RESTORE_NODES' }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRestorableNode(value: unknown): value is Node {
  if (!isRecord(value)) return false;
  const position = value.position;
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.type === 'string' &&
    value.type.length > 0 &&
    isRecord(position) &&
    Number.isFinite(position.x) &&
    Number.isFinite(position.y) &&
    (value.data === undefined || isRecord(value.data)) &&
    (value.parentId === undefined ||
      value.parentId === null ||
      (typeof value.parentId === 'string' && value.parentId.length > 0))
  );
}

function isRestorableEdge(value: unknown): value is Edge {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.source === 'string' &&
    value.source.length > 0 &&
    typeof value.target === 'string' &&
    value.target.length > 0
  );
}

const restoreNodes: CommandDefinition<Cmd> = {
  meta: {
    // The undo that issues it is itself the history step.
    snapshot: 'no',
    requiresEdgeReroute: false,
  },

  handler(cmd, state) {
    const inputNodes: unknown[] = Array.isArray(cmd.nodes) ? cmd.nodes : [];
    const inputEdges: unknown[] = Array.isArray(cmd.edges) ? cmd.edges : [];
    if (inputNodes.length === 0 && inputEdges.length === 0)
      return noop(state, 'no-op');
    if (!inputNodes.every(isRestorableNode))
      return noop(state, 'invalid-target');
    if (!inputEdges.every(isRestorableEdge))
      return noop(state, 'invalid-target');

    const replaceIds = new Set<string>(cmd.replace ?? []);
    const keepDataKeys = cmd.keepDataKeys ?? [];
    const existing = new Map(state.nodes.map((node) => [node.id, node]));
    const incoming = new Map<string, Node>();

    for (const raw of inputNodes) {
      if (incoming.has(raw.id)) return noop(state, 'duplicate-id');
      const current = existing.get(raw.id);
      const replaces = replaceIds.has(raw.id);
      if (replaces && !current) return noop(state, 'not-found');
      if (!replaces && current) return noop(state, 'duplicate-id');
      // An Agent Node's identity is established by its own association
      // path, and never changes type.
      if (raw.type === 'question' && !current)
        return noop(state, 'invalid-target');
      if (
        current &&
        (current.type === 'question') !== (raw.type === 'question')
      )
        return noop(state, 'invalid-target');

      const { parentId, ...rest } = stripTransientNodeFields(raw) as Node;
      let data: Record<string, unknown> = { ...(raw.data ?? {}) };
      if (current) {
        const currentData = (current.data ?? {}) as Record<string, unknown>;
        for (const key of keepDataKeys) {
          if (Object.prototype.hasOwnProperty.call(currentData, key))
            data[key] = currentData[key];
          else delete data[key];
        }
        if (current.type === 'question')
          data = preserveAgentNodeOwnedData(data, currentData);
      }
      const restored: Node = {
        ...rest,
        ...(parentId ? { parentId } : {}),
        data,
      };
      // What a renderer measured is not the snapshot's to say: a replaced
      // node keeps its live box, and a returning one starts from the box
      // last reported for exactly this content, if any.
      const reported = current ? undefined : readMeasuredSizeHint(restored);
      const measured =
        current?.measured ??
        (reported && reported.measuredFor === measuredSizeKey(restored)
          ? { width: reported.width, height: reported.height }
          : undefined);
      incoming.set(raw.id, measured ? { ...restored, measured } : restored);
    }
    for (const id of replaceIds) {
      if (!incoming.has(id)) return noop(state, 'invalid-target');
    }

    const result = new Map<string, Node>(existing);
    for (const [id, node] of incoming) result.set(id, node);

    // Every restored node must hang from a container that exists once the
    // command has run, without closing a loop.
    for (const node of incoming.values()) {
      const seen = new Set<string>([node.id]);
      let parentId = node.parentId;
      while (parentId) {
        const parent = result.get(parentId);
        if (!parent || !isContainerNode(parent))
          return noop(state, 'invalid-parent');
        if (seen.has(parentId)) return noop(state, 'cycle');
        seen.add(parentId);
        // A node comes back under a lock only as the non-draggable member
        // it was when it left.
        if (
          parent.data?.locked === true &&
          !existing.has(node.id) &&
          node.draggable !== false
        )
          return noop(state, 'invalid-parent');
        parentId = parent.parentId;
      }
    }

    const edges = new Map(state.edges.map((edge) => [edge.id, edge]));
    const edgeOrder = state.edges.map((edge) => edge.id);
    const restoredEdgeIds = new Set<string>();
    for (const raw of inputEdges) {
      if (restoredEdgeIds.has(raw.id)) return noop(state, 'duplicate-id');
      restoredEdgeIds.add(raw.id);
      if (!result.has(raw.source) || !result.has(raw.target))
        return noop(state, 'not-found');
      if (!edges.has(raw.id)) edgeOrder.push(raw.id);
      edges.set(raw.id, stripTransientEdgeFields(raw));
    }

    const nextNodes = [
      ...state.nodes.map((node) => incoming.get(node.id) ?? node),
      ...[...incoming.values()].filter((node) => !existing.has(node.id)),
    ];

    return {
      applied: true,
      nodes: nextNodes,
      edges: edgeOrder.map((id) => edges.get(id) as Edge),
      // The host writes each restored node's content back with it. A
      // replacement that keeps data keys leaves the stored content alone.
      mutatedNodes: [...incoming.values()].filter(
        (node) => !existing.has(node.id) || keepDataKeys.length === 0,
      ),
      // A restored node comes back to the place it had, key included.
      placedTrackKeyIds: [...incoming.keys()],
    };
  },
};

export default restoreNodes;
