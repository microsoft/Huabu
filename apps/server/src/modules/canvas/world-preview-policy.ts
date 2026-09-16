// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { CANVAS_NODE_TYPES } from '@huabu/shared';
import { COMMAND_META, getDescendantIds } from '@huabu/shared/canvas-engine';

import { getStructuredStore, isWorldCanvasId } from '../storage/index.js';

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

/** Read membership once at each World mutation boundary. */
export async function readLiveSpaceIds(): Promise<ReadonlySet<string>> {
  const summaries = await getStructuredStore().spaces().list();
  return new Set(summaries.map((summary) => summary.canvasId));
}

export class WorldPreviewMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorldPreviewMutationError';
  }
}

function previewTarget(node: StoredNode): string | null {
  return node.type === 'spacePreview' &&
    typeof node.data?.targetCanvasId === 'string' &&
    node.data.targetCanvasId.length > 0
    ? node.data.targetCanvasId
    : null;
}

/** Validate supplied discriminators without tightening the loose full-state shape. */
export function assertCurrentCanvasNodeTypes(nodes: readonly unknown[]): void {
  if (
    storedNodes(nodes).some((node) =>
      [node.type, node.data?.type].some(
        (type) =>
          type !== undefined &&
          !(CANVAS_NODE_TYPES as readonly unknown[]).includes(type),
      ),
    )
  ) {
    throw new WorldPreviewMutationError('Unsupported canvas node type');
  }
}

/** Preflight the full command registry before any batch I/O. */
export function assertCurrentCanvasCommands(
  commands: readonly unknown[],
): void {
  for (const input of commands) {
    const type = (input as { type?: unknown })?.type;
    if (
      typeof type !== 'string' ||
      !Object.prototype.hasOwnProperty.call(COMMAND_META, type)
    )
      throw new WorldPreviewMutationError('Unsupported canvas command type');
  }
}

/** Full-state writes preserve managed identity, but may change geometry. */
export function assertWorldPreviewTopologyAllowed(
  canvasId: string,
  previousNodesInput: readonly unknown[],
  nextNodesInput: readonly unknown[],
  liveCanvasIds: ReadonlySet<string>,
): void {
  assertWorldPreviewResultAllowed(
    canvasId,
    previousNodesInput,
    nextNodesInput,
    liveCanvasIds,
  );
  if (!isWorldCanvasId(canvasId)) return;
  const previousById = new Map(
    storedNodes(previousNodesInput).map((node) => [node.id, node]),
  );
  for (const node of storedNodes(nextNodesInput)) {
    if (node.type !== 'spacePreview') continue;
    const target = previewTarget(node);
    const previous = previousById.get(node.id);
    if (!target || !previous || previewTarget(previous) !== target)
      throw new WorldPreviewMutationError(
        'World Space previews may only be created by reconciliation',
      );
  }
}

/** Check the sequential result too: reparent-then-delete must not bypass ownership. */
export function assertWorldPreviewResultAllowed(
  canvasId: string,
  previousNodesInput: readonly unknown[],
  nextNodesInput: readonly unknown[],
  liveCanvasIds: ReadonlySet<string>,
): void {
  assertCurrentCanvasNodeTypes(nextNodesInput);
  if (!isWorldCanvasId(canvasId)) return;
  const nextById = new Map(
    storedNodes(nextNodesInput).map((node) => [node.id, node]),
  );
  const seenTargets = new Set<string>();
  for (const node of storedNodes(nextNodesInput)) {
    if (node.type !== 'spacePreview') continue;
    const target = previewTarget(node);
    if (!target || seenTargets.has(target))
      throw new WorldPreviewMutationError(
        'World Space previews require one unique targetCanvasId',
      );
    seenTargets.add(target);
  }
  for (const previous of storedNodes(previousNodesInput)) {
    if (previous.type !== 'spacePreview') continue;
    const target = previewTarget(previous);
    const next = nextById.get(previous.id);
    if (
      (next && previewTarget(next) !== target) ||
      (!next && target && liveCanvasIds.has(target))
    )
      throw new WorldPreviewMutationError(
        'A canonical Space preview cannot be deleted, repointed, or change node type while live',
      );
  }
}

/** Enforce system-owned World previews before command execution. */
export function assertWorldPreviewMutationsAllowed(
  canvasId: string,
  commands: readonly CanvasCommand[],
  nodes: readonly StoredNode[],
  source: 'ui' | 'agent' | 'system',
  liveCanvasIds: ReadonlySet<string>,
): void {
  if (source === 'system' || !isWorldCanvasId(canvasId)) return;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const command of commands) {
    if (
      command.type === 'CREATE_NODES' &&
      command.nodes.some((node) => node.nodeType === 'spacePreview')
    )
      throw new WorldPreviewMutationError(
        'World Space previews are created by reconciliation',
      );
    if (command.type === 'DELETE_NODES') {
      const deletedIds = new Set(command.nodeIds as string[]);
      for (const nodeId of command.nodeIds)
        for (const id of getDescendantIds(nodes as NestableNode[], nodeId))
          deletedIds.add(id);
      if (
        [...deletedIds].some((id) => {
          const node = byId.get(id);
          const target = node && previewTarget(node);
          return target && liveCanvasIds.has(target);
        })
      )
        throw new WorldPreviewMutationError(
          'A live canonical Space preview cannot be deleted',
        );
    }
    if (
      command.type === 'MERGE_NODE_DATA' &&
      command.patches.some(
        (entry) =>
          byId.get(entry.nodeId)?.type === 'spacePreview' &&
          'targetCanvasId' in (entry.patch ?? {}),
      )
    )
      throw new WorldPreviewMutationError(
        'A canonical Space preview cannot be repointed',
      );
    if (
      command.type === 'CHANGE_NODE_TYPE' &&
      byId.get(command.nodeId)?.type === 'spacePreview'
    )
      throw new WorldPreviewMutationError(
        'World Space previews cannot change node type',
      );
    if (
      command.type === 'DISSOLVE_FRAME' &&
      byId.get(command.frameId)?.type === 'spacePreview'
    )
      throw new WorldPreviewMutationError('Space previews cannot be dissolved');
  }
}
