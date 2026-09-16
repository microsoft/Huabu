// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  createId,
  type CanvasCommand,
  type CanvasNodeCreateInput,
  type CanvasNodeId,
} from '@huabu/shared';
import { getNodeDefaultSize } from '@huabu/shared/canvas-engine';

import { executeOnServer } from './canvas-executor.js';
import { getStructuredStore, space } from '../storage/index.js';

const PREVIEW_SIZE = getNodeDefaultSize('spacePreview');
const PREVIEW_WIDTH = PREVIEW_SIZE.width ?? 480;
const PREVIEW_HEIGHT = PREVIEW_SIZE.height ?? 320;
const PREVIEW_GAP = 80;
const PREVIEW_COLUMNS = 4;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface StoredWorldNode {
  id: string;
  type?: string;
  position: { x: number; y: number };
  parentId?: string;
  data?: Record<string, unknown>;
  style?: { width?: number | string; height?: number | string };
}

export class WorldPreviewIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorldPreviewIntegrityError';
  }
}

let reconciliationQueue: Promise<void> = Promise.resolve();

function overlaps(a: Rect, b: Rect): boolean {
  return !(
    a.x + a.width + PREVIEW_GAP <= b.x ||
    b.x + b.width + PREVIEW_GAP <= a.x ||
    a.y + a.height + PREVIEW_GAP <= b.y ||
    b.y + b.height + PREVIEW_GAP <= a.y
  );
}

function findOpenPreviewSlot(occupied: readonly Rect[]): {
  x: number;
  y: number;
} {
  for (let slot = 0; ; slot += 1) {
    const candidate = {
      x: (slot % PREVIEW_COLUMNS) * (PREVIEW_WIDTH + PREVIEW_GAP),
      y: Math.floor(slot / PREVIEW_COLUMNS) * (PREVIEW_HEIGHT + PREVIEW_GAP),
      width: PREVIEW_WIDTH,
      height: PREVIEW_HEIGHT,
    };
    if (!occupied.some((rect) => overlaps(candidate, rect))) {
      return { x: candidate.x, y: candidate.y };
    }
  }
}

function dimension(
  value: number | string | undefined,
  fallback: number,
): number {
  const parsed =
    typeof value === 'number' ? value : Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function absolutePosition(
  node: StoredWorldNode,
  byId: ReadonlyMap<string, StoredWorldNode>,
): { x: number; y: number } {
  let x = node.position.x;
  let y = node.position.y;
  let parentId = node.parentId;
  const visited = new Set<string>();
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    x += parent.position.x;
    y += parent.position.y;
    parentId = parent.parentId;
  }
  return { x, y };
}

/**
 * Ensure every live ordinary Space has exactly one canonical preview in World.
 * Preserve existing preview identity and geometry; remove only deleted targets.
 */
interface WorldPreviewReconciliationPlan {
  worldCanvasId: string;
  deleteNodeIds: CanvasNodeId[];
  inputs: CanvasNodeCreateInput[];
}

async function planWorldPreviewReconciliation(): Promise<WorldPreviewReconciliationPlan> {
  // One repository instance spans World resolution and membership, so a
  // Workspace switch between them is rejected by the handle rather than
  // reconciling one Workspace's previews against another's Space list.
  const spaces = getStructuredStore().spaces();
  const worldCanvasId = await spaces.worldId();
  const world = await space(worldCanvasId).read();
  if (!world) {
    throw new WorldPreviewIntegrityError('World Canvas is not readable');
  }

  const nodes = world.state.nodes as StoredWorldNode[];
  const previewByTarget = new Map<string, StoredWorldNode>();

  for (const node of nodes) {
    if (node.type !== 'spacePreview') continue;
    const targetCanvasId = (
      node.data as { targetCanvasId?: unknown } | undefined
    )?.targetCanvasId;
    if (typeof targetCanvasId !== 'string' || targetCanvasId.length === 0) {
      throw new WorldPreviewIntegrityError(
        `World Space entry ${node.id} has no valid targetCanvasId`,
      );
    }
    if (previewByTarget.has(targetCanvasId)) {
      throw new WorldPreviewIntegrityError(
        `World contains duplicate ${node.type} nodes for Canvas ${targetCanvasId}`,
      );
    }
    previewByTarget.set(targetCanvasId, node);
  }

  // `list()` promises no order, and slot allocation is positional, so the
  // deterministic layout comes from sorting here rather than from a backend
  // happening to scan in a stable order.
  const members = (await spaces.list()).sort((a, b) =>
    a.canvasId.localeCompare(b.canvasId),
  );
  const liveCanvasIds = new Set(members.map((member) => member.canvasId));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const occupied: Rect[] = nodes.map((node) => {
    const position = absolutePosition(node, byId);
    return {
      x: position.x,
      y: position.y,
      width: dimension(node.style?.width, 200),
      height: dimension(node.style?.height, 100),
    };
  });

  const deleteNodeIds = nodes
    .filter(
      (node) =>
        node.type === 'spacePreview' &&
        typeof node.data?.targetCanvasId === 'string' &&
        !liveCanvasIds.has(node.data.targetCanvasId),
    )
    .map((node) => node.id as CanvasNodeId);

  const inputs: CanvasNodeCreateInput[] = members.flatMap((member) => {
    if (previewByTarget.has(member.canvasId)) return [];
    const position = findOpenPreviewSlot(occupied);
    const size = {
      width: PREVIEW_WIDTH,
      height: PREVIEW_HEIGHT,
    };
    occupied.push({
      ...position,
      ...size,
    });
    return [
      {
        id: createId('node') as CanvasNodeId,
        nodeType: 'spacePreview' as const,
        position,
        size,
        data: {
          targetCanvasId: member.canvasId,
        },
        selectOnCreate: false,
      },
    ];
  });

  return { worldCanvasId, deleteNodeIds, inputs };
}

async function reconcileWorldPreviewsOnce(): Promise<void> {
  const { worldCanvasId, deleteNodeIds, inputs } =
    await planWorldPreviewReconciliation();
  if (inputs.length === 0 && deleteNodeIds.length === 0) return;

  const commands: CanvasCommand[] = [];
  if (deleteNodeIds.length > 0) {
    commands.push({ type: 'DELETE_NODES', nodeIds: deleteNodeIds });
  }
  if (inputs.length > 0) {
    commands.push({ type: 'CREATE_NODES', nodes: inputs });
  }
  const result = await executeOnServer({
    canvasId: worldCanvasId,
    commands,
    originator: { source: 'system' },
  });
  if (result.results.some((commandResult) => !commandResult.applied)) {
    // Another writer may have satisfied the plan before execution (for
    // example, deleting an already-stale preview). Accept only a freshly
    // verified complete state, never a blanket suppression of rejected work.
    const remaining = await planWorldPreviewReconciliation();
    if (
      remaining.worldCanvasId === worldCanvasId &&
      remaining.inputs.length === 0 &&
      remaining.deleteNodeIds.length === 0
    )
      return;
    throw new WorldPreviewIntegrityError(
      'Failed to reconcile canonical Space previews',
    );
  }
}

export function reconcileWorldPreviews(): Promise<void> {
  const result = reconciliationQueue.then(reconcileWorldPreviewsOnce);
  reconciliationQueue = result.catch(() => {});
  return result;
}
