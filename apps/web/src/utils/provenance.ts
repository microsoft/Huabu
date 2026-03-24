/**
 * Block-level content provenance utilities.
 *
 * Handles expansion of the `__all__` sentinel key (set by the server when AI
 * creates/updates content via Markdown) into per-block entries, and records
 * user edits against existing provenance entries.
 */

import type { BlockProvenance, BlockProvenanceMap } from '@sediment/shared';

/**
 * Expand the `__all__` sentinel provenance entry into per-block entries.
 *
 * When the server stamps provenance via Markdown (no block IDs available), it
 * uses `{ __all__: { author: 'ai', ... } }`. Once the editor parses the
 * Markdown into blocks, this function replaces the sentinel with one entry per
 * block ID so that per-block tracking can begin.
 *
 * If no `__all__` key exists the map is returned as-is.
 */
export function expandSentinelProvenance(
  map: BlockProvenanceMap | undefined,
  blockIds: string[],
): BlockProvenanceMap | undefined {
  if (!map || !('__all__' in map)) return map;

  const sentinel = map.__all__;
  const expanded: BlockProvenanceMap = {};
  for (const id of blockIds) {
    expanded[id] = { ...sentinel };
  }
  return expanded;
}

/**
 * Record a user edit on a specific block.
 *
 * - If the block has no provenance entry yet: creates a `{ author: 'user' }` entry.
 * - If the block was AI-authored: appends a `{ by: 'user' }` modification.
 * - If the block was already user-authored: no-op (no modification history needed).
 *
 * Returns a new map (immutable update).
 */
export function recordUserEdit(
  map: BlockProvenanceMap | undefined,
  blockId: string,
): BlockProvenanceMap {
  const result = { ...(map ?? {}) };
  const existing = result[blockId];

  if (!existing) {
    // New block added by user — create a fresh entry
    result[blockId] = {
      author: 'user',
      createdAt: new Date().toISOString(),
    };
    return result;
  }

  if (existing.author === 'ai') {
    // AI-authored block modified by user — append modification
    result[blockId] = {
      ...existing,
      modifications: [
        ...(existing.modifications ?? []),
        { by: 'user', at: new Date().toISOString() },
      ],
    };
    return result;
  }

  // Already user-authored — no-op
  return result;
}

/**
 * Compute a summary of block provenance for display purposes.
 */
export function summarizeProvenance(map: BlockProvenanceMap | undefined): {
  aiCount: number;
  userCount: number;
  mixedCount: number;
  total: number;
} {
  if (!map) return { aiCount: 0, userCount: 0, mixedCount: 0, total: 0 };

  let aiCount = 0;
  let userCount = 0;
  let mixedCount = 0;

  for (const [key, entry] of Object.entries(map)) {
    if (key === '__all__') continue;
    if (entry.author === 'ai') {
      const hasUserMod = entry.modifications?.some((m) => m.by === 'user');
      if (hasUserMod) {
        mixedCount++;
      } else {
        aiCount++;
      }
    } else {
      userCount++;
    }
  }

  return {
    aiCount,
    userCount,
    mixedCount,
    total: aiCount + userCount + mixedCount,
  };
}

/**
 * Get the effective author status of a block for visual display.
 */
export function getBlockAuthorStatus(
  entry: BlockProvenance | undefined,
): 'ai' | 'user-modified' | 'user' | 'none' {
  if (!entry) return 'none';
  if (entry.author === 'ai') {
    const hasUserMod = entry.modifications?.some((m) => m.by === 'user');
    return hasUserMod ? 'user-modified' : 'ai';
  }
  return 'user';
}
