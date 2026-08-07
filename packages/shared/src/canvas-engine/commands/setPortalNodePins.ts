// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { noop, type CommandDefinition } from './types.js';
import {
  applyContainerFit,
  computeContainerFit,
  getDescendantIds,
  moveNodeIntoContainer,
  syncInheritedContainerLocks,
} from '../container/index.js';
import {
  NODE_REF_DEFAULT_HEIGHT,
  NODE_REF_DEFAULT_WIDTH,
  placePortalNodeRef,
} from '../portal/index.js';

import type {
  CanvasCommand,
  PreparedPortalNodePin,
  PreparedPortalNodePinsCommand,
} from '../../index.js';
import type { NestableNode } from '../container/index.js';

type Cmd = Extract<CanvasCommand, { type: 'SET_PORTAL_NODE_PINS' }>;

function pinKey(sourceCanvasId: string, sourceNodeId: string): string {
  return `${sourceCanvasId}\0${sourceNodeId}`;
}

function targetOf(
  node: NestableNode,
): { canvasId: string; nodeId: string } | null {
  const target = (
    node.data as
      | { target?: { canvasId?: unknown; nodeId?: unknown } }
      | undefined
  )?.target;
  return typeof target?.canvasId === 'string' &&
    typeof target.nodeId === 'string'
    ? { canvasId: target.canvasId, nodeId: target.nodeId }
    : null;
}

function inheritsContainerLock(
  nodes: readonly NestableNode[],
  parentId: string,
): boolean {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visited = new Set<string>();
  let current = byId.get(parentId);
  while (current) {
    if (visited.has(current.id)) return false;
    visited.add(current.id);
    if (
      current.data?.locked === true ||
      current.data?.__dragDisabledByFrameLock === true
    ) {
      return true;
    }
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return false;
}

function validateDesiredStates(cmd: Cmd): Map<string, boolean> | null {
  const desired = new Map<string, boolean>();
  for (const update of cmd.updates) {
    for (const sourceNodeId of update.sourceNodeIds) {
      const key = pinKey(update.sourceCanvasId, sourceNodeId);
      const previous = desired.get(key);
      if (previous !== undefined && previous !== update.pinned) return null;
      desired.set(key, update.pinned);
    }
  }
  return desired;
}

function preparedByKey(
  pins: readonly PreparedPortalNodePin[],
): Map<string, PreparedPortalNodePin> | null {
  const prepared = new Map<string, PreparedPortalNodePin>();
  for (const pin of pins) {
    const key = pinKey(pin.sourceCanvasId, pin.sourceNodeId);
    const previous = prepared.get(key);
    if (previous && previous.pinned !== pin.pinned) return null;
    if (!previous) prepared.set(key, pin);
  }
  return prepared;
}

const setPortalNodePins: CommandDefinition<Cmd> = {
  meta: {
    snapshot: 'yes',
    requiresEdgeReroute: true,
  },

  handler(cmd, state) {
    const preparedCommand = cmd as PreparedPortalNodePinsCommand;
    const desired = validateDesiredStates(cmd);
    if (!desired) return noop(state, 'conflict');
    if (desired.size === 0) return noop(state);
    if (!preparedCommand.prepared) return noop(state, 'invalid-target');

    const prepared = preparedByKey(preparedCommand.prepared.pins);
    if (!prepared) return noop(state, 'conflict');
    for (const [key, pinned] of desired) {
      if (prepared.get(key)?.pinned !== pinned) {
        return noop(state, 'invalid-target');
      }
    }

    let nodes = state.nodes as NestableNode[];
    let edges = state.edges;
    const affectedPortalIds = new Set<string>();
    const deletedNodeIds: string[] = [];
    let changed = false;

    for (const pin of preparedCommand.prepared.pins) {
      const pinned = pin.pinned;
      const portal = nodes.find((node) => node.id === pin.portalId);
      const portalTarget = (
        portal?.data as { targetCanvasId?: unknown } | undefined
      )?.targetCanvasId;
      if (portal?.type !== 'canvasRef' || portalTarget !== pin.sourceCanvasId) {
        return noop(state, 'invalid-parent');
      }

      const matches = nodes.filter((node) => {
        if (node.type !== 'nodeRef' && node.type !== 'frameRef') return false;
        const target = targetOf(node);
        return (
          target?.canvasId === pin.sourceCanvasId &&
          target.nodeId === pin.sourceNodeId
        );
      });
      if (matches.length > 1) {
        return noop(state, 'conflict');
      }

      let existing = matches[0];
      if (pinned) {
        const parentRefId = pin.parentRefId ?? pin.portalId;
        const parent = nodes.find((node) => node.id === parentRefId);
        if (!parent) return noop(state, 'invalid-parent');
        const referenceType = pin.referenceType ?? 'nodeRef';
        if (existing && existing.type !== referenceType) {
          if (
            existing.type === 'frameRef' &&
            nodes.some((node) => node.parentId === existing?.id)
          ) {
            return noop(state, 'conflict');
          }
          nodes = nodes.map((node) =>
            node.id === existing?.id
              ? {
                  ...node,
                  type: referenceType,
                  data: { ...node.data, type: referenceType },
                }
              : node,
          );
          existing = nodes.find((node) => node.id === existing?.id) ?? existing;
          changed = true;
        }
        if (existing) {
          if (existing.parentId === parentRefId) continue;
          const previousParentId = existing.parentId;
          const moved = moveNodeIntoContainer(nodes, existing.id, parentRefId, {
            ignoreContainerLock: true,
          });
          if (moved === nodes) return noop(state, 'invalid-parent');
          nodes = syncInheritedContainerLocks(moved, existing.id);
          if (previousParentId) affectedPortalIds.add(previousParentId);
          affectedPortalIds.add(parentRefId);
          changed = true;
          continue;
        }
        const sourcePosition = preparedCommand.prepared.sourcePositions.find(
          (entry) =>
            entry.sourceCanvasId === pin.sourceCanvasId &&
            entry.sourceNodeId === pin.sourceNodeId,
        )?.position;
        const placementSourcePosition = sourcePosition ?? pin.position;
        if (!placementSourcePosition) {
          return noop(state, 'invalid-target');
        }
        if (nodes.some((node) => node.id === pin.nodeRefId)) {
          return noop(state, 'duplicate-id');
        }
        const position = pin.position
          ? pin.position
          : placePortalNodeRef(
              nodes,
              pin.portalId,
              pin.sourceCanvasId,
              placementSourcePosition,
              preparedCommand.prepared.sourcePositions,
            );
        const inheritedLock = inheritsContainerLock(nodes, parentRefId);
        nodes = [
          ...nodes,
          {
            id: pin.nodeRefId,
            type: pin.referenceType ?? 'nodeRef',
            parentId: parentRefId,
            position,
            style: {
              width:
                pin.referenceType === 'frameRef'
                  ? (pin.size?.width ?? 400)
                  : NODE_REF_DEFAULT_WIDTH,
              height:
                pin.referenceType === 'frameRef'
                  ? (pin.size?.height ?? 300)
                  : NODE_REF_DEFAULT_HEIGHT,
            },
            measured: {
              width:
                pin.referenceType === 'frameRef'
                  ? (pin.size?.width ?? 400)
                  : NODE_REF_DEFAULT_WIDTH,
              height:
                pin.referenceType === 'frameRef'
                  ? (pin.size?.height ?? 300)
                  : NODE_REF_DEFAULT_HEIGHT,
            },
            ...(inheritedLock ? { draggable: false } : {}),
            data: {
              type: pin.referenceType ?? 'nodeRef',
              target: {
                canvasId: pin.sourceCanvasId,
                nodeId: pin.sourceNodeId,
              },
              ...(inheritedLock ? { __dragDisabledByFrameLock: true } : {}),
            },
          },
        ];
      } else {
        if (!existing) continue;
        const removed = new Set([
          existing.id,
          ...getDescendantIds(nodes, existing.id),
        ]);
        nodes = nodes.filter((node) => !removed.has(node.id));
        edges = edges.filter(
          (edge) => !removed.has(edge.source) && !removed.has(edge.target),
        );
        deletedNodeIds.push(...removed);
      }
      affectedPortalIds.add(
        existing?.parentId ?? pin.parentRefId ?? pin.portalId,
      );
      affectedPortalIds.add(pin.portalId);
      changed = true;
    }

    if (changed) {
      const frameRefs = nodes
        .filter((node) => node.type === 'frameRef')
        .sort((a, b) => {
          const depth = (node: NestableNode): number => {
            let value = 0;
            let parentId = node.parentId;
            while (parentId) {
              value += 1;
              parentId = nodes.find(
                (candidate) => candidate.id === parentId,
              )?.parentId;
            }
            return value;
          };
          return depth(b) - depth(a);
        });
      for (const frameRef of frameRefs) {
        const fit = computeContainerFit(nodes, frameRef.id);
        if (fit) nodes = applyContainerFit(nodes, fit);
      }
    }

    if (!changed) return noop(state);
    return {
      applied: true,
      nodes,
      edges,
      deletedNodeIds,
      affectedPortalIds: [...affectedPortalIds],
    };
  },
};

export default setPortalNodePins;
