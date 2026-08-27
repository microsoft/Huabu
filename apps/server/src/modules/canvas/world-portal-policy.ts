// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { fitPortals, getDescendantIds } from '@huabu/shared/canvas-engine';

import {
  isWorldCanvasId,
  listCanvasDirEntries,
} from '../storage/canvas-dirs.js';

import type { CanvasCommand } from '@huabu/shared';
import type { NestableNode } from '@huabu/shared/canvas-engine';

interface StoredNode {
  id?: string;
  type?: string;
  parentId?: string;
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

function previewTarget(node: StoredNode): string | null {
  return node.type === 'spacePreview' &&
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

function portalPosition(node: StoredNode): unknown {
  return (node as StoredNode & { position?: unknown }).position;
}

function nodeRefTarget(
  node: StoredNode,
): { canvasId: string; nodeId: string } | null {
  const target = node.data?.target as
    | { canvasId?: unknown; nodeId?: unknown }
    | undefined;
  return (node.type === 'nodeRef' || node.type === 'frameRef') &&
    typeof target?.canvasId === 'string' &&
    typeof target.nodeId === 'string'
    ? { canvasId: target.canvasId, nodeId: target.nodeId }
    : null;
}

function hasValidNodeRefData(node: StoredNode): boolean {
  return Object.entries(node.data ?? {}).every(([key, value]) => {
    if (key === 'type') return value === node.type;
    if (key === 'target') {
      return (
        nodeRefTarget(node) !== null &&
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        Object.keys(value).length === 2 &&
        Object.prototype.hasOwnProperty.call(value, 'canvasId') &&
        Object.prototype.hasOwnProperty.call(value, 'nodeId')
      );
    }
    if (key === 'locked') return typeof value === 'boolean';
    if (key === 'style') {
      return (
        typeof value === 'object' && value !== null && !Array.isArray(value)
      );
    }
    if (key === '__dragDisabledByFrameLock') return value === true;
    return false;
  });
}

function hasOnlyWorldNodeRefPatch(
  patch: Record<string, unknown> | undefined,
): boolean {
  return Object.entries(patch ?? {}).every(
    ([key, value]) =>
      key === 'style' &&
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value),
  );
}

function ancestorPortal(
  node: StoredNode,
  byId: ReadonlyMap<string | undefined, StoredNode>,
): StoredNode | null {
  const visited = new Set<string | undefined>([node.id]);
  let parent = node.parentId ? byId.get(node.parentId) : undefined;
  while (parent) {
    if (visited.has(parent.id)) return null;
    visited.add(parent.id);
    if (parent.type === 'canvasRef') return parent;
    parent = parent.parentId ? byId.get(parent.parentId) : undefined;
  }
  return null;
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
  const nextPreviews = nextNodes.filter((node) => node.type === 'spacePreview');
  const nextNodeRefs = nextNodes.filter(
    (node) => node.type === 'nodeRef' || node.type === 'frameRef',
  );
  if (!isWorldCanvasId(canvasId)) {
    if (nextPortals.length > 0 || nextNodeRefs.length > 0) {
      throw new WorldPortalMutationError(
        'Portals and references may only exist in the World Canvas',
      );
    }
    return;
  }

  const previousById = new Map(previousNodes.map((node) => [node.id, node]));
  const nextById = new Map(nextNodes.map((node) => [node.id, node]));
  const nextFrameRefs = nextNodeRefs.filter((node) => node.type === 'frameRef');
  const fitTargets = [...nextFrameRefs, ...nextPortals]
    .map((node) => node.id)
    .filter((id): id is string => typeof id === 'string');
  const fittedNodes = fitPortals(
    nextNodes as unknown as NestableNode[],
    fitTargets,
  );
  const fittedById = new Map(fittedNodes.map((node) => [node.id, node]));
  const seenNodeRefTargets = new Set<string>();
  for (const nodeRef of nextNodeRefs) {
    const target = nodeRefTarget(nodeRef);
    let parent = nodeRef.parentId ? nextById.get(nodeRef.parentId) : undefined;
    const visited = new Set([nodeRef.id]);
    let matchingPortal = false;
    while (parent?.id) {
      if (visited.has(parent.id)) {
        throw new WorldPortalMutationError(
          'World reference hierarchy is cyclic',
        );
      }
      visited.add(parent.id);
      const parentReference = nodeRefTarget(parent);
      if (
        parent.type === 'frameRef' &&
        parentReference?.canvasId !== target?.canvasId
      ) {
        break;
      }
      const parentCanvasId = portalTarget(parent);
      if (parentCanvasId) {
        matchingPortal = parentCanvasId === target?.canvasId;
        break;
      }
      parent = parent.parentId ? nextById.get(parent.parentId) : undefined;
    }
    if (
      !target ||
      !matchingPortal ||
      (nodeRef.parentId &&
        nextById.get(nodeRef.parentId)?.type !== 'canvasRef' &&
        nextById.get(nodeRef.parentId)?.type !== 'frameRef')
    ) {
      throw new WorldPortalMutationError(
        `Reference ${nodeRef.id} must be under its matching Portal`,
      );
    }
    if (!hasValidNodeRefData(nodeRef)) {
      throw new WorldPortalMutationError(
        `Node reference ${nodeRef.id} contains unsupported source-owned data`,
      );
    }
    const targetKey = `${target.canvasId}\0${target.nodeId}`;
    if (seenNodeRefTargets.has(targetKey)) {
      throw new WorldPortalMutationError(
        `World contains duplicate references for ${target.canvasId}/${target.nodeId}`,
      );
    }
    seenNodeRefTargets.add(targetKey);
    const previous = previousById.get(nodeRef.id);
    if (!previous || previous.type !== nodeRef.type) {
      throw new WorldPortalMutationError(
        'References may only be created by Portal Pin commands',
      );
    }
    const previousTarget = nodeRefTarget(previous);
    if (
      !previousTarget ||
      previousTarget.canvasId !== target.canvasId ||
      previousTarget.nodeId !== target.nodeId
    ) {
      throw new WorldPortalMutationError(
        'A node reference cannot be repointed',
      );
    }
  }

  for (const frameRef of nextFrameRefs) {
    const fitted = frameRef.id ? fittedById.get(frameRef.id) : undefined;
    const hasChildren = nextNodes.some((node) => node.parentId === frameRef.id);
    const previous = frameRef.id ? previousById.get(frameRef.id) : undefined;
    if (
      !fitted ||
      (hasChildren
        ? portalDimension(fitted, 'width') !==
            portalDimension(frameRef, 'width') ||
          portalDimension(fitted, 'height') !==
            portalDimension(frameRef, 'height') ||
          JSON.stringify(portalPosition(fitted)) !==
            JSON.stringify(portalPosition(frameRef))
        : !previous ||
          portalDimension(previous, 'width') !==
            portalDimension(frameRef, 'width') ||
          portalDimension(previous, 'height') !==
            portalDimension(frameRef, 'height'))
    ) {
      throw new WorldPortalMutationError(
        'Frame reference size is managed by its contents',
      );
    }
  }

  const seenTargets = new Set<string>();

  for (const preview of nextPreviews) {
    const target = previewTarget(preview);
    if (!target || seenTargets.has(target)) {
      throw new WorldPortalMutationError(
        'World Space previews require one unique targetCanvasId',
      );
    }
    seenTargets.add(target);
    const previous = previousById.get(preview.id);
    if (!previous || previewTarget(previous) !== target) {
      throw new WorldPortalMutationError(
        'World Space previews may only be created by reconciliation',
      );
    }
  }

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
    const fitted = portal.id ? fittedById.get(portal.id) : undefined;
    if (
      !fitted ||
      portalDimension(fitted, 'width') !== portalDimension(portal, 'width') ||
      portalDimension(fitted, 'height') !== portalDimension(portal, 'height') ||
      JSON.stringify(portalPosition(fitted)) !==
        JSON.stringify(portalPosition(portal))
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
    const previousNodeRef = nodeRefTarget(previous);
    if (previousNodeRef) {
      const next = nextById.get(previous.id);
      const previousPortal = ancestorPortal(previous, previousById);
      const ancestorTarget = previousPortal
        ? portalTarget(previousPortal)
        : null;
      const removesBrokenPortalSubtree =
        ancestorTarget !== null &&
        !liveCanvasIds.has(ancestorTarget) &&
        previousPortal?.id !== undefined &&
        !nextById.has(previousPortal.id);
      if (!next && !removesBrokenPortalSubtree) {
        throw new WorldPortalMutationError(
          'Node references must be removed with SET_PORTAL_NODE_PINS',
        );
      }
      if (next && next.type !== 'nodeRef' && next.type !== 'frameRef') {
        throw new WorldPortalMutationError(
          'A node reference cannot change node type',
        );
      }
    }
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
  for (const previous of previousNodes) {
    const target = previewTarget(previous);
    if (!target) continue;
    const next = nextById.get(previous.id);
    if (next && next.type !== 'spacePreview') {
      throw new WorldPortalMutationError(
        'A canonical Space preview cannot change node type',
      );
    }
    if (liveCanvasIds.has(target) && !next) {
      throw new WorldPortalMutationError(
        'A live canonical Space preview cannot be deleted',
      );
    }
  }
}

/** Recheck live Portal retention against the final sequential batch result. */
export function assertWorldPortalResultAllowed(
  canvasId: string,
  previousNodesInput: readonly unknown[],
  nextNodesInput: readonly unknown[],
): void {
  if (!isWorldCanvasId(canvasId)) return;

  const liveCanvasIds = new Set(
    listCanvasDirEntries().map((entry) => entry.id),
  );
  const nextById = new Map(
    storedNodes(nextNodesInput).map((node) => [node.id, node]),
  );
  const nextPreviewTargets = new Set(
    storedNodes(nextNodesInput)
      .map(previewTarget)
      .filter((target): target is string => target !== null),
  );
  for (const previous of storedNodes(previousNodesInput)) {
    const target = portalTarget(previous);
    if (!target || !liveCanvasIds.has(target)) continue;
    const next = nextById.get(previous.id);
    if (
      (!next ||
        (portalTarget(next) !== target && previewTarget(next) !== target)) &&
      !nextPreviewTargets.has(target)
    ) {
      throw new WorldPortalMutationError(
        'A live canonical Portal cannot be deleted or repointed',
      );
    }
  }
  for (const previous of storedNodes(previousNodesInput)) {
    const target = previewTarget(previous);
    if (!target || !liveCanvasIds.has(target)) continue;
    const next = nextById.get(previous.id);
    if (!next || previewTarget(next) !== target) {
      throw new WorldPortalMutationError(
        'A live canonical Space preview cannot be deleted or repointed',
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
      command.nodes.some(
        (node) =>
          node.nodeType === 'nodeRef' ||
          node.nodeType === 'frameRef' ||
          node.nodeType === 'canvasRef',
      )
    ) {
      throw new WorldPortalMutationError(
        'Portals and references have dedicated creation commands',
      );
    }
  }

  if (!isWorldCanvasId(canvasId)) return;

  const liveCanvasIds = new Set(
    listCanvasDirEntries().map((entry) => entry.id),
  );
  const byId = new Map(nodes.map((node) => [node.id, node]));

  for (const command of commands) {
    if (
      command.type === 'CREATE_NODES' &&
      command.nodes.some((node) => node.nodeType === 'spacePreview')
    ) {
      throw new WorldPortalMutationError(
        'World Space previews are created by reconciliation',
      );
    }
    if (command.type === 'DELETE_NODES') {
      const deletedIds = new Set(command.nodeIds as string[]);
      for (const nodeId of command.nodeIds) {
        for (const descendantId of getDescendantIds(
          nodes as NestableNode[],
          nodeId,
        )) {
          deletedIds.add(descendantId);
        }
      }

      const deletesNodeRefDirectly = command.nodeIds.some((nodeId) => {
        const node = byId.get(nodeId);
        return (
          (node?.type === 'nodeRef' || node?.type === 'frameRef') &&
          (!node.parentId || !deletedIds.has(node.parentId))
        );
      });
      if (deletesNodeRefDirectly) {
        throw new WorldPortalMutationError(
          'Node references must be removed with SET_PORTAL_NODE_PINS',
        );
      }
      const deletesLivePortal = [...deletedIds].some((nodeId) => {
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
      const deletesLivePreview = [...deletedIds].some((nodeId) => {
        const node = byId.get(nodeId);
        return (
          node?.type === 'spacePreview' &&
          typeof node.data?.targetCanvasId === 'string' &&
          liveCanvasIds.has(node.data.targetCanvasId)
        );
      });
      if (deletesLivePreview) {
        throw new WorldPortalMutationError(
          'A live canonical Space preview cannot be deleted',
        );
      }
    }

    if (command.type === 'MERGE_NODE_DATA') {
      const mutatesNodeRefData = command.patches.some((entry) => {
        const node = byId.get(entry.nodeId);
        return (
          (node?.type === 'nodeRef' || node?.type === 'frameRef') &&
          !hasOnlyWorldNodeRefPatch(entry.patch)
        );
      });
      if (mutatesNodeRefData) {
        throw new WorldPortalMutationError(
          'A node reference cannot persist copied source-owned data',
        );
      }
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
      const repointsPreview = command.patches.some((entry) => {
        const node = byId.get(entry.nodeId);
        return (
          node?.type === 'spacePreview' &&
          'targetCanvasId' in (entry.patch ?? {})
        );
      });
      if (repointsPreview) {
        throw new WorldPortalMutationError(
          'A canonical Space preview cannot be repointed',
        );
      }
    }

    if (command.type === 'DISSOLVE_FRAME') {
      const target = byId.get(command.frameId);
      if (
        target?.type === 'canvasRef' ||
        target?.type === 'spacePreview' ||
        target?.type === 'nodeRef' ||
        target?.type === 'frameRef'
      ) {
        throw new WorldPortalMutationError(
          'Portals and node references cannot be dissolved',
        );
      }
    }

    if (command.type === 'CHANGE_NODE_TYPE') {
      const target = byId.get(command.nodeId);
      if (
        target?.type === 'canvasRef' ||
        target?.type === 'spacePreview' ||
        target?.type === 'nodeRef' ||
        target?.type === 'frameRef'
      ) {
        throw new WorldPortalMutationError(
          'Portals and node references cannot change node type',
        );
      }
    }

    if (command.type === 'SET_NODE_GEOMETRY') {
      const resizesManagedContainer = command.items.some(
        (item) =>
          item.size &&
          (byId.get(item.nodeId)?.type === 'canvasRef' ||
            byId.get(item.nodeId)?.type === 'frameRef'),
      );
      if (resizesManagedContainer) {
        throw new WorldPortalMutationError(
          'Portal and frame reference sizes are managed by their contents',
        );
      }
    }
  }
}
