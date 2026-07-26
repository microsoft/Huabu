import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  isWorldCanvasId,
  refreshCanvasDirIndex,
} from '../storage/canvas-dirs.js';
import { getCanvasStore } from '../storage/index.js';
import { SPACE_JSON_FILENAME } from '../storage/paths.js';
import { getWorkspacePath } from '../workspace.js';

import type { CanvasFile } from '../storage/canvas-store.js';

interface StoredNode {
  type?: string;
  data?: Record<string, unknown>;
}

export class WorldTargetAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorldTargetAccessError';
  }
}

export function readWorldTargetCanvasesStrict(
  canvasIds: ReadonlySet<string>,
): Map<string, CanvasFile | null> {
  const matches = new Map<string, CanvasFile | null>(
    [...canvasIds].map((canvasId) => [canvasId, null] as const),
  );
  const workspace = getWorkspacePath();
  for (const entry of readdirSync(workspace)) {
    if (entry.startsWith('.')) continue;
    const root = path.join(workspace, entry);
    if (!statSync(root).isDirectory()) continue;
    const topologyPath = path.join(root, SPACE_JSON_FILENAME);
    if (!existsSync(topologyPath)) continue;
    const raw = readFileSync(topologyPath, 'utf8');
    const canvas = JSON.parse(raw) as CanvasFile;
    if (!canvasIds.has(canvas.canvasId)) continue;
    if (matches.get(canvas.canvasId)) {
      throw new WorldTargetAccessError(
        `Canvas ${canvas.canvasId} has duplicate topology`,
      );
    }
    if (
      !Array.isArray(canvas.state?.nodes) ||
      !Array.isArray(canvas.state.edges)
    ) {
      throw new WorldTargetAccessError(
        `Canvas ${canvas.canvasId} has malformed topology`,
      );
    }
    matches.set(canvas.canvasId, canvas);
  }
  return matches;
}

/**
 * Resolve an optional read target without extending write authority.
 * Explicit cross-Canvas reads are available only from World and only through
 * one canonical Portal in the current World topology.
 */
export function resolveWorldReadCanvasId(
  ownerCanvasId: string,
  targetCanvasId: string | undefined,
): string {
  if (!targetCanvasId) return ownerCanvasId;
  if (!isWorldCanvasId(ownerCanvasId)) {
    throw new WorldTargetAccessError(
      'targetCanvasId is available only in a World conversation',
    );
  }

  const world = getCanvasStore(ownerCanvasId).read();
  if (!world) {
    throw new WorldTargetAccessError('World Canvas is not readable');
  }

  const matches = (world.state.nodes as StoredNode[]).filter(
    (node) =>
      node.type === 'canvasRef' && node.data?.targetCanvasId === targetCanvasId,
  );
  if (matches.length !== 1) {
    throw new WorldTargetAccessError(
      `Canvas ${targetCanvasId} is not addressed by one canonical World Portal`,
    );
  }
  readWorldTargetCanvasesStrict(new Set([targetCanvasId]));
  refreshCanvasDirIndex();
  return targetCanvasId;
}
