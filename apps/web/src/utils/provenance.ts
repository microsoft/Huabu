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
    // Set baselineText to '' to mark as brand-new AI block with pending diff,
    // so the diff bar shows deep purple and the block appears in blockDiffMap.
    expanded[id] = { ...sentinel, baselineText: '' };
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
 * Batch variant of `recordUserEdit` — applies user edits for multiple block IDs
 * with a single shallow copy of the map.
 */
export function recordUserEdits(
  map: BlockProvenanceMap | undefined,
  blockIds: string[],
): BlockProvenanceMap {
  if (blockIds.length === 0) return map ?? {};
  const result = { ...(map ?? {}) };
  const now = new Date().toISOString();
  for (const blockId of blockIds) {
    const existing = result[blockId];
    if (!existing) {
      result[blockId] = { author: 'user', createdAt: now };
    } else if (existing.author === 'ai') {
      result[blockId] = {
        ...existing,
        modifications: [
          ...(existing.modifications ?? []),
          { by: 'user', at: now },
        ],
      };
    }
  }
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
 * Returns true if any block in the provenance map has pure 'ai' status
 * (AI-authored with no user modifications).
 */
export function hasAnyPureAiBlock(
  map: BlockProvenanceMap | undefined,
): boolean {
  if (!map) return false;
  for (const [key, entry] of Object.entries(map)) {
    if (key === '__all__') continue;
    if (getBlockAuthorStatus(entry) === 'ai') return true;
  }
  return false;
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
// Diff types
// ---------------------------------------------------------------------------

export interface DeletedBlockInfo {
  /** The plain text content of the deleted block. */
  text: string;
  /**
   * ID of the surviving block after which the deletion occurred.
   * `null` means the deletion was at the very beginning of the document.
   */
  afterBlockId: string | null;
}

// ---------------------------------------------------------------------------
// Diff-merge: preserve per-block provenance after AI full-content replacement
// ---------------------------------------------------------------------------

/** Minimal block shape needed for content-based matching. */
export interface ProvenanceBlock {
  id: string;
  type: string;
  content?: unknown;
  children?: unknown;
}

/** Extract plain text from a BlockNote block, recursing into children. */
export function extractBlockText(block: ProvenanceBlock): string {
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
export function blockFingerprint(block: ProvenanceBlock): string {
  return `${block.type}::${extractBlockText(block)}`;
}

/** Split text into a multiset of lowercase words for similarity comparison. */
function wordBag(text: string): Map<string, number> {
  const bag = new Map<string, number>();
  for (const w of text.toLowerCase().split(/\s+/)) {
    if (w) bag.set(w, (bag.get(w) ?? 0) + 1);
  }
  return bag;
}

/** Jaccard-style similarity between two word bags (0–1). */
function jaccardSimilarity(
  a: Map<string, number>,
  b: Map<string, number>,
): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  let union = 0;
  const allKeys = new Set([...a.keys(), ...b.keys()]);
  for (const key of allKeys) {
    const ca = a.get(key) ?? 0;
    const cb = b.get(key) ?? 0;
    intersection += Math.min(ca, cb);
    union += Math.max(ca, cb);
  }
  return union > 0 ? intersection / union : 0;
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
 * - Matched (identical content): old provenance carried over as-is (including
 *   any existing `baselineText` for cumulative diffs).
 * - Unmatched new blocks: stamped with AI sentinel + `baselineText` set to
 *   the paired old block's original baseline (cumulative) or current text.
 * - Deleted old blocks: stored as `__deleted_N__` entries with `baselineText`.
 */
export function mergeProvenanceAfterAIUpdate(
  oldProvenance: BlockProvenanceMap,
  oldBlocks: ProvenanceBlock[],
  newBlocks: ProvenanceBlock[],
  sentinel: BlockProvenance,
): BlockProvenanceMap {
  // Build an ordered pool of old-block entries keyed by content fingerprint.
  // Each pool item carries both the provenance entry and the block itself,
  // so we can extract text for baselineText when blocks are unmatched.
  const pool = new Map<
    string,
    { entry: BlockProvenance; block: ProvenanceBlock }[]
  >();
  for (const block of oldBlocks) {
    const entry = oldProvenance[block.id];
    if (!entry) continue;
    const fp = blockFingerprint(block);
    const list = pool.get(fp) ?? [];
    list.push({ entry, block });
    pool.set(fp, list);
  }

  const result: BlockProvenanceMap = {};
  const matchedOldBlockIds = new Set<string>();
  const unmatchedNewBlockIds: string[] = [];

  for (const block of newBlocks) {
    const fp = blockFingerprint(block);
    const matches = pool.get(fp);
    if (matches && matches.length > 0) {
      const match = matches.shift()!;
      if (matches.length === 0) pool.delete(fp);
      // Content unchanged — carry over old provenance as-is (including
      // existing baselineText and modification history).
      result[block.id] = { ...match.entry };
      matchedOldBlockIds.add(match.block.id);
    } else {
      // New or modified by AI — stamp with sentinel provenance.
      result[block.id] = { ...sentinel };
      unmatchedNewBlockIds.push(block.id);
    }
  }

  // Collect unmatched old blocks in document order.
  const unmatchedOld: { entry: BlockProvenance; block: ProvenanceBlock }[] = [];
  for (const block of oldBlocks) {
    const entry = oldProvenance[block.id];
    if (entry && !matchedOldBlockIds.has(block.id)) {
      unmatchedOld.push({ entry, block });
    }
  }

  // Pair unmatched old blocks with unmatched new blocks using word-level
  // similarity, maintaining document order. This avoids the positional-index
  // approach which misaligns when the AI inserts brand-new blocks between
  // modified blocks.
  //
  // Similarity is computed against the old block's CURRENT text (not its
  // baselineText) because the new block's content is most similar to the last
  // version of the old block, not the original baseline.
  // Pre-compute word bags for old blocks to avoid repeated work.
  const oldWordBags = unmatchedOld.map(({ block }) =>
    wordBag(extractBlockText(block)),
  );

  // Index new blocks by ID for O(1) lookup.
  const newBlockById = new Map<string, ProvenanceBlock>();
  for (const b of newBlocks) newBlockById.set(b.id, b);

  const pairedOldBlockIds = new Set<string>();
  let oldSearchStart = 0;
  for (const newBlockId of unmatchedNewBlockIds) {
    const newBlock = newBlockById.get(newBlockId)!;
    const newWords = wordBag(extractBlockText(newBlock));

    let bestIdx = -1;
    let bestScore = 0;
    for (let i = oldSearchStart; i < unmatchedOld.length; i++) {
      const score = jaccardSimilarity(newWords, oldWordBags[i]);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    if (bestScore >= 0.15 && bestIdx >= 0) {
      const { entry: oldEntry, block: oldBlock } = unmatchedOld[bestIdx];
      result[newBlockId].baselineText =
        oldEntry.baselineText ?? extractBlockText(oldBlock);
      pairedOldBlockIds.add(oldBlock.id);
      oldSearchStart = bestIdx + 1;
    } else {
      // Brand-new block added by AI — empty baseline.
      result[newBlockId].baselineText = '';
    }
  }

  // Excess unmatched old blocks = deletions by AI.
  // Walk old blocks in document order to determine positional context
  // (which surviving new block each deletion falls after).
  let lastMatchedNewId: string | null = null;
  // Build old→new ID mapping for matched blocks.
  const oldToNewId = new Map<string, string>();
  {
    // Re-walk using fingerprint pools (rebuild since consumed above).
    const fpPool2 = new Map<string, string[]>();
    for (const block of oldBlocks) {
      if (!matchedOldBlockIds.has(block.id)) continue;
      const fp = blockFingerprint(block);
      const list = fpPool2.get(fp) ?? [];
      list.push(block.id);
      fpPool2.set(fp, list);
    }
    for (const block of newBlocks) {
      const fp = blockFingerprint(block);
      const list = fpPool2.get(fp);
      if (list && list.length > 0) {
        oldToNewId.set(list.shift()!, block.id);
        if (list.length === 0) fpPool2.delete(fp);
      }
    }
  }

  // Build a set of new block IDs for quick lookup.
  const newBlockIdSet = new Set(newBlocks.map((b) => b.id));

  let deletedIdx = 0;
  for (const block of oldBlocks) {
    if (matchedOldBlockIds.has(block.id)) {
      lastMatchedNewId = oldToNewId.get(block.id) ?? lastMatchedNewId;
    } else if (!pairedOldBlockIds.has(block.id) && oldProvenance[block.id]) {
      const entry = oldProvenance[block.id];
      const text = entry.baselineText ?? extractBlockText(block);
      if (text.trim()) {
        result[`__deleted_${deletedIdx}__`] = {
          ...sentinel,
          deleted: true,
          baselineText: text,
          afterBlockId: lastMatchedNewId,
        };
        deletedIdx++;
      }
    }
  }

  // Carry forward existing __deleted_* entries from previous AI operations,
  // remapping their afterBlockId from old block IDs to new block IDs.
  for (const [key, entry] of Object.entries(oldProvenance)) {
    if (!key.startsWith('__deleted_')) continue;
    if (!entry.deleted || !entry.baselineText?.trim()) continue;

    let remappedAfterId = entry.afterBlockId ?? null;
    if (remappedAfterId !== null) {
      // Try direct mapping via oldToNewId
      const directMap = oldToNewId.get(remappedAfterId);
      if (directMap) {
        remappedAfterId = directMap;
      } else if (!newBlockIdSet.has(remappedAfterId)) {
        // afterBlockId references a block that no longer exists in new blocks.
        // Walk backward through oldBlocks to find the nearest preceding
        // matched block and use its new ID.
        let found = false;
        const anchorIdx = oldBlocks.findIndex((b) => b.id === remappedAfterId);
        if (anchorIdx >= 0) {
          for (let i = anchorIdx - 1; i >= 0; i--) {
            const mappedId = oldToNewId.get(oldBlocks[i].id);
            if (mappedId) {
              remappedAfterId = mappedId;
              found = true;
              break;
            }
          }
        }
        if (!found) {
          remappedAfterId = null;
        }
      }
      // else: remappedAfterId already points to a valid new block ID
    }

    result[`__deleted_${deletedIdx}__`] = {
      ...entry,
      afterBlockId: remappedAfterId,
    };
    deletedIdx++;
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

// ---------------------------------------------------------------------------
// Baseline / diff derivation utilities
// ---------------------------------------------------------------------------

/**
 * Returns true if any block in the provenance map has a pending diff
 * (has a `baselineText` field, including `__deleted_*` entries).
 */
export function hasAnyPendingDiff(
  map: BlockProvenanceMap | undefined,
): boolean {
  if (!map) return false;
  for (const [key, entry] of Object.entries(map)) {
    if (key === '__all__') continue;
    if (entry.baselineText !== undefined) return true;
  }
  return false;
}

/**
 * Derive a block diff map from provenance.
 * Returns a Map of blockId → baselineText for non-deleted AI blocks
 * that have a pending diff (baselineText defined).
 */
export function deriveBlockDiffMap(
  map: BlockProvenanceMap | undefined,
): Map<string, string> {
  const result = new Map<string, string>();
  if (!map) return result;
  for (const [key, entry] of Object.entries(map)) {
    if (key === '__all__' || key.startsWith('__deleted_')) continue;
    if (
      entry.baselineText !== undefined &&
      getBlockAuthorStatus(entry) === 'ai'
    ) {
      result.set(key, entry.baselineText);
    }
  }
  return result;
}

/**
 * Derive deleted block info from `__deleted_N__` provenance entries.
 */
export function deriveDeletedBlocks(
  map: BlockProvenanceMap | undefined,
): DeletedBlockInfo[] {
  if (!map) return [];
  const entries = Object.entries(map)
    .filter(([k]) => k.startsWith('__deleted_'))
    .sort(([a], [b]) => {
      const ai = parseInt(a.replace('__deleted_', '').replace('__', ''), 10);
      const bi = parseInt(b.replace('__deleted_', '').replace('__', ''), 10);
      return ai - bi;
    });
  const result: DeletedBlockInfo[] = [];
  for (const [, entry] of entries) {
    if (entry.deleted && entry.baselineText?.trim()) {
      result.push({
        text: entry.baselineText,
        afterBlockId: entry.afterBlockId ?? null,
      });
    }
  }
  return result;
}

/**
 * Remove `baselineText` from a specific block's provenance entry.
 */
export function clearBaselineText(
  map: BlockProvenanceMap | undefined,
  blockId: string,
): BlockProvenanceMap {
  if (!map || !map[blockId]) return map ?? {};
  const { baselineText: _, ...rest } = map[blockId];
  return { ...map, [blockId]: rest as BlockProvenance };
}

/**
 * Remove all `baselineText` fields and `__deleted_*` entries from provenance.
 */
export function clearAllBaselines(
  map: BlockProvenanceMap | undefined,
): BlockProvenanceMap {
  if (!map) return {};
  const result: BlockProvenanceMap = {};
  for (const [key, entry] of Object.entries(map)) {
    if (key.startsWith('__deleted_')) continue;
    if (entry.baselineText !== undefined) {
      const { baselineText: _, ...rest } = entry;
      result[key] = rest as BlockProvenance;
    } else {
      result[key] = entry;
    }
  }
  return result;
}

/**
 * Remove a specific `__deleted_N__` entry from provenance.
 */
export function removeDeletedEntry(
  map: BlockProvenanceMap | undefined,
  deletedKey: string,
): BlockProvenanceMap {
  if (!map) return {};
  const { [deletedKey]: _, ...rest } = map;
  return rest;
}

/**
 * Get sorted `__deleted_N__` keys from a provenance map.
 */
export function getDeletedKeys(map: BlockProvenanceMap | undefined): string[] {
  if (!map) return [];
  return Object.keys(map)
    .filter((k) => k.startsWith('__deleted_'))
    .sort((a, b) => {
      const ai = parseInt(a.replace('__deleted_', '').replace('__', ''), 10);
      const bi = parseInt(b.replace('__deleted_', '').replace('__', ''), 10);
      return ai - bi;
    });
}

/**
 * Repair stale `afterBlockId` references in `__deleted_*` entries.
 *
 * When a block that serves as an `afterBlockId` anchor is removed from the
 * document (e.g. user deletes or merges it), the reference becomes stale and
 * the deletion indicator would disappear. This function walks the previous
 * ordered block list to find the nearest preceding block that still exists in
 * the current document, and updates the `afterBlockId` accordingly.
 *
 * @param map          Current provenance map (may be mutated-copy).
 * @param currentIds   Set of block IDs currently in the editor document.
 * @param prevOrderedIds  Ordered array of block IDs from the previous state.
 * @returns            A new provenance map with repaired anchors, or the
 *                     original map if no repair was needed.
 */
export function repairDeletedBlockAnchors(
  map: BlockProvenanceMap | undefined,
  currentIds: Set<string>,
  prevOrderedIds: string[],
): BlockProvenanceMap | undefined {
  if (!map) return map;

  let result: BlockProvenanceMap | undefined;
  for (const key of Object.keys(map)) {
    if (!key.startsWith('__deleted_')) continue;
    const entry = map[key];
    const aid = entry.afterBlockId;
    if (aid !== null && aid !== undefined && !currentIds.has(aid)) {
      const prevIdx = prevOrderedIds.indexOf(aid);
      let newAfterId: string | null = null;
      if (prevIdx >= 0) {
        for (let i = prevIdx - 1; i >= 0; i--) {
          if (currentIds.has(prevOrderedIds[i])) {
            newAfterId = prevOrderedIds[i];
            break;
          }
        }
      }
      if (!result) result = { ...map };
      result[key] = { ...entry, afterBlockId: newAfterId };
    }
  }
  return result ?? map;
}
