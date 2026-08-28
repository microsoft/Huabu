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
const PORTAL_WIDTH = PREVIEW_SIZE.width ?? 480;
const PORTAL_HEIGHT = PREVIEW_SIZE.height ?? 320;
const PORTAL_GAP = 80;
const PORTAL_COLUMNS = 4;

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

export class WorldPortalIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorldPortalIntegrityError';
  }
}

let reconciliationQueue: Promise<void> = Promise.resolve();

function overlaps(a: Rect, b: Rect): boolean {
  return !(
    a.x + a.width + PORTAL_GAP <= b.x ||
    b.x + b.width + PORTAL_GAP <= a.x ||
    a.y + a.height + PORTAL_GAP <= b.y ||
    b.y + b.height + PORTAL_GAP <= a.y
  );
}

function findOpenPortalSlot(occupied: readonly Rect[]): {
  x: number;
  y: number;
} {
  for (let slot = 0; ; slot += 1) {
    const candidate = {
      x: (slot % PORTAL_COLUMNS) * (PORTAL_WIDTH + PORTAL_GAP),
      y: Math.floor(slot / PORTAL_COLUMNS) * (PORTAL_HEIGHT + PORTAL_GAP),
      width: PORTAL_WIDTH,
      height: PORTAL_HEIGHT,
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
 * Ensure every live ordinary Space has exactly one canonical Portal in World.
 * Existing nodes and geometry are never changed; only missing Portals are added.
 */
interface WorldPortalReconciliationPlan {
  worldCanvasId: string;
  deleteNodeIds: CanvasNodeId[];
  inputs: CanvasNodeCreateInput[];
}

async function planWorldPortalReconciliation(): Promise<WorldPortalReconciliationPlan> {
  // One repository instance spans World resolution and membership, so a
  // Workspace switch between them is rejected by the handle rather than
  // reconciling one Workspace's Portals against another's Space list.
  const spaces = getStructuredStore().spaces();
  const worldCanvasId = await spaces.worldId();
  const world = await space(worldCanvasId).read();
  if (!world) {
    throw new WorldPortalIntegrityError('World Canvas is not readable');
  }

  const nodes = world.state.nodes as StoredWorldNode[];
  const previewByTarget = new Map<string, StoredWorldNode>();
  const legacyPortalByTarget = new Map<string, StoredWorldNode>();

  for (const node of nodes) {
    if (node.type !== 'spacePreview' && node.type !== 'canvasRef') continue;
    const targetCanvasId = (
      node.data as { targetCanvasId?: unknown } | undefined
    )?.targetCanvasId;
    if (typeof targetCanvasId !== 'string' || targetCanvasId.length === 0) {
      throw new WorldPortalIntegrityError(
        `World Space entry ${node.id} has no valid targetCanvasId`,
      );
    }
    const targetMap =
      node.type === 'spacePreview' ? previewByTarget : legacyPortalByTarget;
    if (targetMap.has(targetCanvasId)) {
      throw new WorldPortalIntegrityError(
        `World contains duplicate ${node.type} nodes for Canvas ${targetCanvasId}`,
      );
    }
    targetMap.set(targetCanvasId, node);
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
        node.type === 'canvasRef' ||
        (node.type === 'spacePreview' &&
          typeof node.data?.targetCanvasId === 'string' &&
          !liveCanvasIds.has(node.data.targetCanvasId)),
    )
    .map((node) => node.id as CanvasNodeId);

  const inputs: CanvasNodeCreateInput[] = members.flatMap((member) => {
    if (previewByTarget.has(member.canvasId)) return [];
    const legacy = legacyPortalByTarget.get(member.canvasId);
    const position = legacy?.position ?? findOpenPortalSlot(occupied);
    const size = {
      width: dimension(legacy?.style?.width, PORTAL_WIDTH),
      height: dimension(legacy?.style?.height, PORTAL_HEIGHT),
    };
    occupied.push({
      ...position,
      ...size,
    });
    return [
      {
        id: (legacy?.id ?? createId('node')) as CanvasNodeId,
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

async function reconcileWorldPortalsOnce(): Promise<void> {
  const { worldCanvasId, deleteNodeIds, inputs } =
    await planWorldPortalReconciliation();
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
    throw new WorldPortalIntegrityError(
      'Failed to reconcile canonical Space previews',
    );
  }
}

export function reconcileWorldPortals(): Promise<void> {
  const result = reconciliationQueue.then(reconcileWorldPortalsOnce);
  reconciliationQueue = result.catch(() => {});
  return result;
}
