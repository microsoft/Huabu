// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { getStructuredStore, isWorldCanvasId } from '../storage/index.js';

import type { CanvasFile } from './persistence-types.js';

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

export async function readWorldTargetCanvasesStrict(
  canvasIds: ReadonlySet<string>,
): Promise<Map<string, CanvasFile | null>> {
  const structured = getStructuredStore();
  return new Map(
    await Promise.all(
      [...canvasIds].map(async (canvasId) => {
        const canvas = await structured.space(canvasId).read();
        return [canvasId, canvas] as const;
      }),
    ),
  );
}

/**
 * Resolve an optional read target without extending write authority.
 * Explicit cross-Canvas reads are available only from World and only through
 * one canonical Portal in the current World topology.
 */
export async function resolveWorldReadCanvasId(
  ownerCanvasId: string,
  targetCanvasId: string | undefined,
): Promise<string> {
  if (!targetCanvasId) return ownerCanvasId;
  if (!(await isWorldCanvasId(ownerCanvasId))) {
    throw new WorldTargetAccessError(
      'targetCanvasId is available only in a World conversation',
    );
  }

  const world = await getStructuredStore().space(ownerCanvasId).read();
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
  const target = (
    await readWorldTargetCanvasesStrict(new Set([targetCanvasId]))
  ).get(targetCanvasId);
  if (!target) {
    throw new WorldTargetAccessError(
      `Canvas ${targetCanvasId} is not readable`,
    );
  }
  return targetCanvasId;
}
