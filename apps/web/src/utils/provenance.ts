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

// ---------------------------------------------------------------------------
// Diff-merge: preserve per-block provenance after AI full-content replacement
// ---------------------------------------------------------------------------

/** Minimal block shape needed for content-based matching. */
interface ProvenanceBlock {
  id: string;
  type: string;
  content?: unknown;
  children?: unknown;
}

/** Extract plain text from a BlockNote block, recursing into children. */
function extractBlockText(block: ProvenanceBlock): string {
  let text = '';
  if (Array.isArray(block.content)) {
    text = (block.content as Array<{ type?: string; text?: string }>)
      .filter((item) => item.type === 'text')
      .map((item) => item.text ?? '')
      .join('');
  }
  if (Array.isArray(block.children)) {
    for (const child of block.children as ProvenanceBlock[]) {
      text += '\n' + extractBlockText(child);
    }
  }
  return text;
}

/** Content fingerprint for matching blocks across ID changes. */
function blockFingerprint(block: ProvenanceBlock): string {
  return `${block.type}::${extractBlockText(block)}`;
}

/**
 * Merge provenance after an AI full-content replacement.
 *
 * When the agent replaces the entire Markdown content, block IDs are lost
 * because the editor re-parses from scratch. This function uses content-based
 * fingerprinting to associate old blocks (with known provenance) to new blocks
 * (with fresh IDs), preserving provenance for blocks whose content was not
 * actually changed by the AI.
 *
 * - Matched (identical content): old provenance carried over as-is.
 * - Unmatched new blocks: stamped with the AI sentinel provenance.
 * - Deleted old blocks: silently removed from the map.
 */
export function mergeProvenanceAfterAIUpdate(
  oldProvenance: BlockProvenanceMap,
  oldBlocks: ProvenanceBlock[],
  newBlocks: ProvenanceBlock[],
  sentinel: BlockProvenance,
): BlockProvenanceMap {
  // Build an ordered pool of old-block provenance keyed by content fingerprint.
  // Multiple blocks may share a fingerprint (e.g. empty paragraphs); the array
  // preserves document order so greedy matching stays positionally consistent.
  const pool = new Map<string, BlockProvenance[]>();
  for (const block of oldBlocks) {
    const entry = oldProvenance[block.id];
    if (!entry) continue;
    const fp = blockFingerprint(block);
    const list = pool.get(fp) ?? [];
    list.push(entry);
    pool.set(fp, list);
  }

  const result: BlockProvenanceMap = {};
  for (const block of newBlocks) {
    const fp = blockFingerprint(block);
    const matches = pool.get(fp);
    if (matches && matches.length > 0) {
      // Content unchanged — carry over old provenance (including any
      // existing modification history from the user).
      result[block.id] = { ...matches.shift()! };
      if (matches.length === 0) pool.delete(fp);
    } else {
      // New or modified by AI — stamp with sentinel provenance.
      result[block.id] = { ...sentinel };
    }
  }

  return result;
}

/**
 * Resolve a provenance map that may contain an `__all__` sentinel.
 *
 * Handles three cases:
 * 1. No sentinel → returns the map as-is (no resolution needed).
 * 2. Sentinel with no old per-block entries → simple expansion.
 * 3. Sentinel with old per-block entries → content-based diff-merge.
 *
 * For case 3, old blocks are taken from `oldBlocksFromEditor` when their IDs
 * overlap with the old provenance keys, otherwise reconstructed from
 * `contentJson` (covers the remount scenario where the editor only held a
 * placeholder paragraph).
 */
export function resolveSentinelProvenance(
  rawProvenance: BlockProvenanceMap | undefined,
  opts: {
    fallbackOldProvenance?: BlockProvenanceMap;
    newBlocks: ProvenanceBlock[];
    oldBlocksFromEditor: ProvenanceBlock[];
    contentJson: string | null;
  },
): BlockProvenanceMap | undefined {
  if (!rawProvenance || !('__all__' in rawProvenance)) return rawProvenance;

  const { fallbackOldProvenance, newBlocks, oldBlocksFromEditor, contentJson } =
    opts;

  // Collect old per-block provenance — first from the map itself (preserved
  // by mergeNodeData), then from the in-memory fallback.
  let oldPerBlock: BlockProvenanceMap | undefined;
  const perBlockEntries = Object.entries(rawProvenance).filter(
    ([k]) => k !== '__all__',
  );
  if (perBlockEntries.length > 0) {
    oldPerBlock = Object.fromEntries(perBlockEntries);
  }
  if (!oldPerBlock && fallbackOldProvenance) {
    const hasEntries = Object.keys(fallbackOldProvenance).some(
      (k) => k !== '__all__',
    );
    if (hasEntries) oldPerBlock = fallbackOldProvenance;
  }

  if (!oldPerBlock) {
    // No old provenance — simple sentinel expansion.
    const blockIds = newBlocks.map((b) => b.id);
    return expandSentinelProvenance(rawProvenance, blockIds) ?? rawProvenance;
  }

  // Determine old blocks for fingerprint matching.
  let oldBlocks = oldBlocksFromEditor;
  const oldBlockIds = new Set(oldBlocks.map((b) => b.id));
  const provenanceCoversEditor = Object.keys(oldPerBlock).some((k) =>
    oldBlockIds.has(k),
  );
  if (!provenanceCoversEditor && contentJson) {
    try {
      const parsed = JSON.parse(contentJson);
      if (Array.isArray(parsed)) {
        oldBlocks = (parsed as ProvenanceBlock[]).map((b) => ({
          id: b.id,
          type: b.type,
          content: b.content,
          children: b.children,
        }));
      }
    } catch {
      // Malformed — use editor snapshot.
    }
  }

  return mergeProvenanceAfterAIUpdate(
    oldPerBlock,
    oldBlocks,
    newBlocks,
    rawProvenance.__all__,
  );
}
