import {
  isWorldCanvasId,
  listCanvasDirEntries,
} from '../storage/canvas-dirs.js';

import type { CanvasCommand } from '@sediment/shared';

interface StoredNode {
  id?: string;
  type?: string;
  data?: Record<string, unknown>;
}

function storedNodes(nodes: readonly unknown[]): StoredNode[] {
  return nodes.filter(
    (node): node is StoredNode => typeof node === 'object' && node !== null,
  );
}

export class WorldPortalMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorldPortalMutationError';
  }
}

function portalTarget(node: StoredNode): string | null {
  return node.type === 'canvasRef' &&
    typeof node.data?.targetCanvasId === 'string' &&
    node.data.targetCanvasId.length > 0
    ? node.data.targetCanvasId
    : null;
}

function portalDimension(node: StoredNode, key: 'width' | 'height'): unknown {
  return (node as StoredNode & { style?: Record<string, unknown> }).style?.[
    key
  ];
}

/**
 * Validate the legacy full-state PUT boundary against the same Portal
 * ownership contract enforced for command execution.
 */
export function assertWorldPortalTopologyAllowed(
  canvasId: string,
  previousNodesInput: readonly unknown[],
  nextNodesInput: readonly unknown[],
): void {
  const previousNodes = storedNodes(previousNodesInput);
  const nextNodes = storedNodes(nextNodesInput);
  const nextPortals = nextNodes.filter((node) => node.type === 'canvasRef');
  if (!isWorldCanvasId(canvasId)) {
    if (nextPortals.length > 0) {
      throw new WorldPortalMutationError(
        'Portals may only exist in the World Canvas',
      );
    }
    return;
  }

  const previousById = new Map(previousNodes.map((node) => [node.id, node]));
  const nextById = new Map(nextNodes.map((node) => [node.id, node]));
  const seenTargets = new Set<string>();

  for (const portal of nextPortals) {
    const target = portalTarget(portal);
    if (!target) {
      throw new WorldPortalMutationError(
        `Portal ${portal.id} has no valid targetCanvasId`,
      );
    }
    if (seenTargets.has(target)) {
      throw new WorldPortalMutationError(
        `World contains duplicate Portals for Canvas ${target}`,
      );
    }
    seenTargets.add(target);

    const previous = previousById.get(portal.id);
    if (!previous || previous.type !== 'canvasRef') {
      throw new WorldPortalMutationError(
        'Portals may only be created by World reconciliation',
      );
    }
    if (portalTarget(previous) !== target) {
      throw new WorldPortalMutationError(
        'A canonical Portal cannot be repointed',
      );
    }
    if (
      portalDimension(previous, 'width') !== portalDimension(portal, 'width') ||
      portalDimension(previous, 'height') !== portalDimension(portal, 'height')
    ) {
      throw new WorldPortalMutationError(
        'Portal size is managed by its contents',
      );
    }
  }

  const liveCanvasIds = new Set(
    listCanvasDirEntries().map((entry) => entry.id),
  );
  for (const previous of previousNodes) {
    const target = portalTarget(previous);
    if (!target) continue;
    const next = nextById.get(previous.id);
    if (next && next.type !== 'canvasRef') {
      throw new WorldPortalMutationError(
        'A canonical Portal cannot change node type',
      );
    }
    if (liveCanvasIds.has(target) && !next) {
      throw new WorldPortalMutationError(
        'A live canonical Portal cannot be deleted',
      );
    }
  }
}

/** Enforce server-authoritative ownership of canonical World Portals. */
export function assertWorldPortalMutationsAllowed(
  canvasId: string,
  commands: readonly CanvasCommand[],
  nodes: readonly StoredNode[],
  source: 'ui' | 'agent' | 'system',
): void {
  if (source === 'system') return;

  for (const command of commands) {
    if (
      command.type === 'CREATE_NODES' &&
      command.nodes.some((node) => node.nodeType === 'canvasRef')
    ) {
      throw new WorldPortalMutationError(
        'Portals may only be created by World reconciliation',
      );
    }
  }

  if (!isWorldCanvasId(canvasId)) return;

  const liveCanvasIds = new Set(
    listCanvasDirEntries().map((entry) => entry.id),
  );
  const byId = new Map(nodes.map((node) => [node.id, node]));

  for (const command of commands) {
    if (command.type === 'DELETE_NODES') {
      const deletesLivePortal = command.nodeIds.some((nodeId) => {
        const node = byId.get(nodeId);
        return (
          node?.type === 'canvasRef' &&
          typeof node.data?.targetCanvasId === 'string' &&
          liveCanvasIds.has(node.data.targetCanvasId)
        );
      });
      if (deletesLivePortal) {
        throw new WorldPortalMutationError(
          'A live canonical Portal cannot be deleted',
        );
      }
    }

    if (command.type === 'MERGE_NODE_DATA') {
      const repointsPortal = command.patches.some((entry) => {
        const node = byId.get(entry.nodeId);
        return (
          node?.type === 'canvasRef' && 'targetCanvasId' in (entry.patch ?? {})
        );
      });
      if (repointsPortal) {
        throw new WorldPortalMutationError(
          'A canonical Portal cannot be repointed',
        );
      }
    }

    if (command.type === 'SET_NODE_GEOMETRY') {
      const resizesPortal = command.items.some(
        (item) => item.size && byId.get(item.nodeId)?.type === 'canvasRef',
      );
      if (resizesPortal) {
        throw new WorldPortalMutationError(
          'Portal size is managed by its contents',
        );
      }
    }
  }
}
