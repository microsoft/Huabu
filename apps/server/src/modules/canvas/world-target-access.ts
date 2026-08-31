// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { getStructuredStore, space } from '../storage/index.js';

import type { CanvasFile } from '../storage/index.js';

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

/**
 * Read the Space records a World reference addresses, strictly.
 *
 * "Strictly" means an unreadable or malformed record raises rather than
 * resolving to a broken reference: a World Portal that silently rendered as
 * "missing" because a record could not be parsed would hide an integrity
 * problem behind an ordinary-looking empty state.
 *
 * Every requested id appears in the result; one that has no Space maps to
 * `null`. This used to walk the Workspace directory reading `space.json`
 * files itself, which made a reference resolver a consumer of the Disk record
 * layout, and made the read cost the whole Workspace rather than the ids
 * asked for.
 */
export async function readWorldTargetCanvasesStrict(
  canvasIds: ReadonlySet<string>,
): Promise<Map<string, CanvasFile | null>> {
  const entries = await Promise.all(
    [...canvasIds].map(async (canvasId) => {
      const record = await space(canvasId).read();
      if (
        record &&
        (!Array.isArray(record.state?.nodes) ||
          !Array.isArray(record.state.edges))
      ) {
        throw new WorldTargetAccessError(
          `Canvas ${canvasId} has malformed topology`,
        );
      }
      return [canvasId, record] as const;
    }),
  );
  return new Map(entries);
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

  const spaces = getStructuredStore().spaces();
  if (ownerCanvasId !== (await spaces.worldId())) {
    throw new WorldTargetAccessError(
      'targetCanvasId is available only in a World conversation',
    );
  }

  const world = await space(ownerCanvasId).read();
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
  // The Portal names it; confirm the Space itself is readable before handing
  // the id to a tool that will read from it.
  await readWorldTargetCanvasesStrict(new Set([targetCanvasId]));
  return targetCanvasId;
}
