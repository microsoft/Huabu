import { noop, type CommandDefinition } from './types.js';
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

    for (const [key, pinned] of desired) {
      const pin = prepared.get(key);
      if (!pin) return noop(state, 'invalid-target');
      const portal = nodes.find((node) => node.id === pin.portalId);
      const portalTarget = (
        portal?.data as { targetCanvasId?: unknown } | undefined
      )?.targetCanvasId;
      if (portal?.type !== 'canvasRef' || portalTarget !== pin.sourceCanvasId) {
        return noop(state, 'invalid-parent');
      }

      const matches = nodes.filter((node) => {
        if (node.type !== 'nodeRef') return false;
        const target = targetOf(node);
        return (
          target?.canvasId === pin.sourceCanvasId &&
          target.nodeId === pin.sourceNodeId
        );
      });
      if (
        matches.length > 1 ||
        (matches.length === 1 && matches[0].parentId !== pin.portalId)
      ) {
        return noop(state, 'conflict');
      }

      const existing = matches[0];
      if (pinned) {
        if (existing) continue;
        const sourcePosition = preparedCommand.prepared.sourcePositions.find(
          (entry) =>
            entry.sourceCanvasId === pin.sourceCanvasId &&
            entry.sourceNodeId === pin.sourceNodeId,
        )?.position;
        if (!sourcePosition) return noop(state, 'invalid-target');
        if (nodes.some((node) => node.id === pin.nodeRefId)) {
          return noop(state, 'duplicate-id');
        }
        const position = placePortalNodeRef(
          nodes,
          pin.portalId,
          pin.sourceCanvasId,
          sourcePosition,
          preparedCommand.prepared.sourcePositions,
        );
        const portalLocked =
          nodes.find((node) => node.id === pin.portalId)?.data?.locked === true;
        nodes = [
          ...nodes,
          {
            id: pin.nodeRefId,
            type: 'nodeRef',
            parentId: pin.portalId,
            position,
            style: {
              width: NODE_REF_DEFAULT_WIDTH,
              height: NODE_REF_DEFAULT_HEIGHT,
            },
            measured: {
              width: NODE_REF_DEFAULT_WIDTH,
              height: NODE_REF_DEFAULT_HEIGHT,
            },
            ...(portalLocked ? { draggable: false } : {}),
            data: {
              type: 'nodeRef',
              target: {
                canvasId: pin.sourceCanvasId,
                nodeId: pin.sourceNodeId,
              },
              ...(portalLocked ? { __dragDisabledByFrameLock: true } : {}),
            },
          },
        ];
      } else {
        if (!existing) continue;
        nodes = nodes.filter((node) => node.id !== existing.id);
        edges = edges.filter(
          (edge) => edge.source !== existing.id && edge.target !== existing.id,
        );
        deletedNodeIds.push(existing.id);
      }
      affectedPortalIds.add(pin.portalId);
      changed = true;
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
