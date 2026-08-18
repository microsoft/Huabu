// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  createId,
  type CanvasCommand,
  type CanvasNodeCreateInput,
  type CanvasNodeId,
} from '@huabu/shared';
import {
  PORTAL_DEFAULT_HEIGHT,
  PORTAL_DEFAULT_WIDTH,
} from '@huabu/shared/canvas-engine';

import { executeOnServer } from './canvas-executor.js';
import { getStructuredStore, requireWorldCanvasId } from '../storage/index.js';

const PORTAL_WIDTH = PORTAL_DEFAULT_WIDTH;
const PORTAL_HEIGHT = PORTAL_DEFAULT_HEIGHT;
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
  nodes: StoredWorldNode[];
  inputs: CanvasNodeCreateInput[];
}

async function planWorldPortalReconciliation(): Promise<WorldPortalReconciliationPlan> {
  const structured = getStructuredStore();
  const worldCanvasId = await requireWorldCanvasId();
  const world = await structured.space(worldCanvasId).read();
  if (!world) {
    throw new WorldPortalIntegrityError('World Canvas is not readable');
  }

  const nodes = world.state.nodes as StoredWorldNode[];
  const portalByTarget = new Map<string, StoredWorldNode>();

  for (const node of nodes) {
    if (node.type !== 'canvasRef') continue;
    const targetCanvasId = (
      node.data as { targetCanvasId?: unknown } | undefined
    )?.targetCanvasId;
    if (typeof targetCanvasId !== 'string' || targetCanvasId.length === 0) {
      throw new WorldPortalIntegrityError(
        `Portal ${node.id} has no valid targetCanvasId`,
      );
    }
    if (portalByTarget.has(targetCanvasId)) {
      throw new WorldPortalIntegrityError(
        `World contains duplicate Portals for Canvas ${targetCanvasId}`,
      );
    }
    portalByTarget.set(targetCanvasId, node);
  }

  const spaces = (await structured.spaces().list())
    .filter((entry) => !portalByTarget.has(entry.canvasId))
    .sort((a, b) => a.canvasId.localeCompare(b.canvasId));
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

  const inputs: CanvasNodeCreateInput[] = spaces.map((space) => {
    const position = findOpenPortalSlot(occupied);
    occupied.push({
      ...position,
      width: PORTAL_WIDTH,
      height: PORTAL_HEIGHT,
    });
    return {
      id: createId('node') as CanvasNodeId,
      nodeType: 'canvasRef' as const,
      position,
      size: { width: PORTAL_WIDTH, height: PORTAL_HEIGHT },
      data: {
        targetCanvasId: space.canvasId,
      },
      selectOnCreate: false,
    };
  });

  return { worldCanvasId, nodes, inputs };
}

async function reconcileWorldPortalsOnce(): Promise<void> {
  const { worldCanvasId, inputs } = await planWorldPortalReconciliation();
  if (inputs.length === 0) return;

  const command: CanvasCommand = {
    type: 'CREATE_NODES',
    nodes: inputs,
  };
  const result = await executeOnServer({
    canvasId: worldCanvasId,
    commands: [command],
    originator: { source: 'system' },
  });
  if (!result.results[0]?.applied) {
    throw new WorldPortalIntegrityError('Failed to create canonical Portals');
  }
}

export function reconcileWorldPortals(): Promise<void> {
  const result = reconciliationQueue.then(reconcileWorldPortalsOnce);
  reconciliationQueue = result.catch(() => {});
  return result;
}
