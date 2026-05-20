/**
 * Block-fingerprint provenance engine (Phase 4 of the Milkdown migration).
 *
 * Replaces the BlockNote-era `apps/web/src/utils/provenance.ts`
 * (block-id-keyed). Milkdown / ProseMirror nodes have no persistent ids,
 * so we identify blocks by a stable hash derived from each top-level
 * block's `node.toJSON()` representation.
 *
 * The module is intentionally pure: it operates on `BlockSnapshot[]`
 * (a structural projection of a PM doc's top-level children) and
 * `MarkdownProvenance` records. Callers in the editor wrapper translate
 * live ProseMirror nodes into `BlockSnapshot` and resolve serialized
 * markdown when they need to stamp / reject. This keeps the engine
 * unit-testable without booting a real editor.
 *
 * Decisions baked in (see `docs/milkdown-migration-plan.md` §4 Pre-flight):
 *  - Fingerprint INCLUDES marks (bold/italic/link → key change → stamp).
 *  - Same-content duplicates within one doc are disambiguated with a
 *    `#N` occurrence-index suffix (1-based for the Nth duplicate; the
 *    first occurrence is unsuffixed).
 *  - Stream-end stamp: callers diff the doc snapshot taken at AI write
 *    start against the final post-stream doc and call `stampAiEdit`
 *    once. Per-chunk stamping is explicitly NOT supported.
 */

import type {
  BlockProvenance,
  DeletedBlockInfo,
  MarkdownProvenance,
} from '@sediment/shared';

/* ------------------------------------------------------------------ */
/* Snapshot type                                                       */
/* ------------------------------------------------------------------ */

/**
 * Structural projection of a top-level ProseMirror block. Callers obtain
 * one of these from `node.toJSON()` or `node.toJSON()` recursively for
 * children. Keep it deliberately loose — any extra attrs the schema adds
 * are absorbed by the index signature.
 */
export interface BlockSnapshot {
  type: string;
  attrs?: Record<string, unknown>;
  content?: BlockSnapshot[];
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  text?: string;
  [extra: string]: unknown;
}

/* ------------------------------------------------------------------ */
/* Stable JSON stringify + hash                                        */
/* ------------------------------------------------------------------ */

/**
 * `JSON.stringify` with sorted object keys, so that schema attribute
 * ordering does not perturb the hash across runs.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    '{' +
    keys
      .map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k]))
      .join(',') +
    '}'
  );
}

/**
 * 32-bit FNV-1a hash, hex-encoded. Adequate for in-doc identity with
 * occurrenceIndex disambiguation; collisions across docs do not matter
 * because provenance is doc-scoped.
 */
function hash(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/* ------------------------------------------------------------------ */
/* Fingerprint API                                                     */
/* ------------------------------------------------------------------ */

/**
 * Compute the bare (un-disambiguated) hash for a block snapshot.
 * Two blocks with identical content produce the same value — use
 * `fingerprintBlocks` when working at doc scope to also get duplicate
 * suffixes.
 */
export function fingerprintBlock(snap: BlockSnapshot): string {
  return hash(stableStringify(snap));
}

/**
 * Compute fingerprints for every top-level block in a doc, applying
 * `#N` suffixes for the 2nd+ occurrence of any duplicate base hash.
 *
 *   blocks = [A, A, B, A]
 *   keys   = ['k(A)', 'k(A)#2', 'k(B)', 'k(A)#3']
 */
export function fingerprintBlocks(snaps: BlockSnapshot[]): string[] {
  const counts = new Map<string, number>();
  return snaps.map((s) => {
    const base = fingerprintBlock(s);
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    return n === 1 ? base : `${base}#${n}`;
  });
}

/* ------------------------------------------------------------------ */
/* Diff                                                                */
/* ------------------------------------------------------------------ */

/**
 * Diff two doc-key arrays. The result drives `stampAiEdit`.
 *
 * For each removed (old) key, also report the surviving anchor key
 * (the nearest-following old key that ALSO appears in newKeys), or
 * `null` when the deletion is at the very end / no surviving neighbor
 * comes after.
 *
 * Why anchor on the *next* surviving block rather than the previous:
 * users naturally read top-to-bottom, so attaching the tombstone after
 * its preceding block (visually below it) is more discoverable. We
 * compute that by scanning newKeys backwards from doc end and matching
 * against old key positions — see implementation.
 */
export function diffBlocks(
  oldKeys: string[],
  newKeys: string[],
): {
  addedKeys: string[];
  removedKeysWithAnchor: Array<{ key: string; anchorKey: string | null }>;
} {
  const newSet = new Set(newKeys);
  const oldSet = new Set(oldKeys);

  const addedKeys = newKeys.filter((k) => !oldSet.has(k));

  const removedKeysWithAnchor: Array<{
    key: string;
    anchorKey: string | null;
  }> = [];

  for (let i = 0; i < oldKeys.length; i++) {
    const k = oldKeys[i];
    if (newSet.has(k)) continue;

    // Anchor = previous surviving block in the OLD sequence (visually
    // the block this tombstone hung "below"). Walk backwards.
    let anchorKey: string | null = null;
    for (let j = i - 1; j >= 0; j--) {
      if (newSet.has(oldKeys[j])) {
        anchorKey = oldKeys[j];
        break;
      }
    }
    removedKeysWithAnchor.push({ key: k, anchorKey });
  }

  return { addedKeys, removedKeysWithAnchor };
}

/* ------------------------------------------------------------------ */
/* Stamp / shift / accept / reject                                     */
/* ------------------------------------------------------------------ */

const EMPTY: MarkdownProvenance = {
  version: 1,
  blocks: [],
  deletedBlocks: [],
};

export function emptyProvenance(): MarkdownProvenance {
  return { version: 1, blocks: [], deletedBlocks: [] };
}

/**
 * Type guard: validates that an unknown value matches the Phase 4
 * `MarkdownProvenance` shape. Used to drop legacy block-id-keyed
 * payloads silently (zero-compat per migration plan §4).
 */
export function isMarkdownProvenance(
  value: unknown,
): value is MarkdownProvenance {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === 1 && Array.isArray(v.blocks) && Array.isArray(v.deletedBlocks)
  );
}

/**
 * Coerce a possibly-legacy provenance value to the Phase 4 shape.
 * Anything that is not a valid `MarkdownProvenance` becomes an empty
 * record. Useful when loading historical NoteNodeData.
 */
export function coerceProvenance(value: unknown): MarkdownProvenance {
  return isMarkdownProvenance(value) ? value : emptyProvenance();
}

export interface StampInput {
  oldKeys: string[];
  newKeys: string[];
  /** Markdown for each old key (must contain entries for removed keys). */
  oldMarkdownByKey: Map<string, string>;
  /** Markdown for each new key (must contain entries for added keys). */
  newMarkdownByKey: Map<string, string>;
  /** ISO timestamp for the stamp (defaults to now). */
  at?: string;
}

/**
 * Apply an AI-edit diff to existing provenance.
 *
 * Pairing semantics: a block whose old fingerprint disappears and is
 * replaced by a new one in the SAME slot (same surrounding surviving
 * blocks) is treated as a **modification**, not a delete+insert. The
 * resulting `BlockProvenance` carries `kind: 'modified'` and the
 * removed block's markdown as `baselineMarkdown`, so the hover popover
 * shows a meaningful word-level diff and Reject restores the original
 * content.
 *
 * Unpaired leftovers fall through:
 *  - Extra new keys → `BlockProvenance` with `kind: 'inserted'` and an
 *    empty baseline. Reject deletes the block.
 *  - Extra removed keys → `DeletedBlockInfo` tombstones with anchors.
 *
 * Existing entries whose key still appears in `newKeys` are kept
 * untouched — they retain their original `baselineMarkdown` and
 * timestamp even if the AI re-stamps them. Existing tombstones whose
 * `anchorKey` survives are likewise kept.
 */
export function stampAiEdit(
  prov: MarkdownProvenance | undefined,
  input: StampInput,
): MarkdownProvenance {
  const at = input.at ?? new Date().toISOString();
  const base = coerceProvenance(prov);
  const newKeySet = new Set(input.newKeys);

  const { modifications, pureAdds, pureRemoves } = pairAddRemoveBySlot(
    input.oldKeys,
    input.newKeys,
  );

  // Keep existing entries whose key still appears.
  const keptBlocks: BlockProvenance[] = base.blocks.filter((b) =>
    newKeySet.has(b.key),
  );
  const keptKeySet = new Set(keptBlocks.map((b) => b.key));

  const newBlocks: BlockProvenance[] = [];

  // Modifications: paired (removedKey, addedKey) within one slot.
  for (const m of modifications) {
    if (keptKeySet.has(m.addedKey)) continue;
    const baselineMarkdown = input.oldMarkdownByKey.get(m.removedKey) ?? '';
    newBlocks.push({
      key: m.addedKey,
      kind: 'modified',
      baselineMarkdown,
      at,
    });
  }

  // Pure inserts: nothing was removed in the same slot.
  for (const key of pureAdds) {
    if (keptKeySet.has(key)) continue;
    newBlocks.push({ key, kind: 'inserted', baselineMarkdown: '', at });
  }

  // Tombstones for unpaired removes. Existing tombstones whose anchorKey
  // still survives are kept first; then we add new ones for newly-removed
  // keys.
  const liveAnchorSet = newKeySet;
  const keptTombstones: DeletedBlockInfo[] = base.deletedBlocks.filter(
    (t) => t.anchorKey === null || liveAnchorSet.has(t.anchorKey),
  );
  const keptTombKeys = new Set(keptTombstones.map((t) => t.key));

  const newTombstones: DeletedBlockInfo[] = [];
  for (const { key, anchorKey } of pureRemoves) {
    if (keptTombKeys.has(key)) continue;
    const baselineMarkdown = input.oldMarkdownByKey.get(key) ?? '';
    // If the anchor itself does not survive the new doc, drop the
    // tombstone — context is gone, can't anchor.
    if (anchorKey !== null && !liveAnchorSet.has(anchorKey)) continue;
    newTombstones.push({ key, baselineMarkdown, anchorKey, at });
  }

  return {
    version: 1,
    blocks: [...keptBlocks, ...newBlocks],
    deletedBlocks: [...keptTombstones, ...newTombstones],
  };
}

/**
 * LCS-based pairing of removed and added keys. Surviving keys form
 * "anchors"; runs of non-survivors between two consecutive anchors are
 * treated as one slot. Within each slot we zip the removed and added
 * runs in order: the first `min(removed.length, added.length)` pairs
 * become modifications; leftovers become pure removes / pure inserts.
 *
 * Anchor for pureRemoves is the previous surviving block in the slot
 * (matching `diffBlocks`'s convention).
 *
 * Complexity: O(N×M) for the LCS table — fine for the doc sizes we
 * handle (a single note rarely exceeds a few hundred blocks).
 */
function pairAddRemoveBySlot(
  oldKeys: string[],
  newKeys: string[],
): {
  modifications: Array<{ removedKey: string; addedKey: string }>;
  pureAdds: string[];
  pureRemoves: Array<{ key: string; anchorKey: string | null }>;
} {
  // Compute the kept (surviving) sequence via LCS.
  const kept = longestCommonSubsequence(oldKeys, newKeys);
  const keptSet = new Set(kept);

  const modifications: Array<{ removedKey: string; addedKey: string }> = [];
  const pureAdds: string[] = [];
  const pureRemoves: Array<{ key: string; anchorKey: string | null }> = [];

  let oi = 0;
  let ni = 0;
  let prevAnchor: string | null = null;

  // Process slots: before each anchor, then after the last one.
  for (let a = 0; a <= kept.length; a++) {
    const anchor = a < kept.length ? kept[a] : undefined;

    const removedRun: string[] = [];
    while (oi < oldKeys.length && oldKeys[oi] !== anchor) {
      if (!keptSet.has(oldKeys[oi])) removedRun.push(oldKeys[oi]);
      oi++;
    }
    const addedRun: string[] = [];
    while (ni < newKeys.length && newKeys[ni] !== anchor) {
      if (!keptSet.has(newKeys[ni])) addedRun.push(newKeys[ni]);
      ni++;
    }

    const pairCount = Math.min(removedRun.length, addedRun.length);
    for (let i = 0; i < pairCount; i++) {
      modifications.push({
        removedKey: removedRun[i],
        addedKey: addedRun[i],
      });
    }
    for (let i = pairCount; i < removedRun.length; i++) {
      pureRemoves.push({ key: removedRun[i], anchorKey: prevAnchor });
    }
    for (let i = pairCount; i < addedRun.length; i++) {
      pureAdds.push(addedRun[i]);
    }

    if (anchor !== undefined) {
      // Skip the anchor token itself in both sequences.
      if (oi < oldKeys.length && oldKeys[oi] === anchor) oi++;
      if (ni < newKeys.length && newKeys[ni] === anchor) ni++;
      prevAnchor = anchor;
    }
  }

  return { modifications, pureAdds, pureRemoves };
}

/**
 * Standard O(N×M) longest common subsequence. Returns a fresh array
 * of the matched elements in order.
 */
function longestCommonSubsequence(a: string[], b: string[]): string[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];
  // dp[i][j] = LCS length of a[0..i) and b[0..j)
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(0),
  );
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const out: string[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      out.push(a[i - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return out.reverse();
}

/**
 * Recompute provenance against the live doc. Drops entries whose key
 * (or tombstone whose anchorKey) no longer exists. Called on every
 * onChange so user edits naturally consume markers.
 */
export function shiftProvenance(
  prov: MarkdownProvenance | undefined,
  liveKeys: string[],
): MarkdownProvenance {
  const base = coerceProvenance(prov);
  if (base.blocks.length === 0 && base.deletedBlocks.length === 0) return EMPTY;
  const live = new Set(liveKeys);
  return {
    version: 1,
    blocks: base.blocks.filter((b) => live.has(b.key)),
    deletedBlocks: base.deletedBlocks.filter(
      (t) => t.anchorKey === null || live.has(t.anchorKey),
    ),
  };
}

/** Drop one BlockProvenance entry by key. Markdown is unchanged. */
export function acceptBlock(
  prov: MarkdownProvenance,
  key: string,
): MarkdownProvenance {
  return {
    version: 1,
    blocks: prov.blocks.filter((b) => b.key !== key),
    deletedBlocks: prov.deletedBlocks,
  };
}

/** Drop one tombstone by key. Markdown is unchanged. */
export function dismissDeletedBlock(
  prov: MarkdownProvenance,
  deletedKey: string,
): MarkdownProvenance {
  return {
    version: 1,
    blocks: prov.blocks,
    deletedBlocks: prov.deletedBlocks.filter((t) => t.key !== deletedKey),
  };
}

/** Drop everything. Markdown is unchanged. */
export function acceptAll(_prov: MarkdownProvenance): MarkdownProvenance {
  return emptyProvenance();
}

/** Read the BlockProvenance entry for a key, or undefined. */
export function findBlockEntry(
  prov: MarkdownProvenance | undefined,
  key: string,
): BlockProvenance | undefined {
  return coerceProvenance(prov).blocks.find((b) => b.key === key);
}

/** Read the DeletedBlockInfo entries that anchor on a given key. */
export function findTombstonesAfter(
  prov: MarkdownProvenance | undefined,
  anchorKey: string | null,
): DeletedBlockInfo[] {
  return coerceProvenance(prov).deletedBlocks.filter(
    (t) => t.anchorKey === anchorKey,
  );
}
