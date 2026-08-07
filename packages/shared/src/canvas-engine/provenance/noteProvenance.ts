// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Host-agnostic note provenance algebra.
 *
 * Operates purely on block-key arrays and {@link MarkdownProvenance}
 * records — it has NO dependency on ProseMirror / the editor, so the
 * exact same logic runs on the server (authoritative provenance
 * computation for AI edits) and in the web editor (user-edit shifting,
 * accept / reject bookkeeping).
 *
 * Block keys come from {@link fingerprintMarkdownBlocks}, which both
 * hosts derive from markdown via the shared mdast fingerprint — see
 * `blockFingerprint.ts` for why raw and Milkdown-normalized markdown
 * produce identical keys.
 *
 * Moved here from `apps/web/src/utils/blockProvenance.ts`; the web file
 * now re-exports these and keeps only the legacy PM-JSON fingerprinter.
 */

import { fingerprintMarkdownBlocks } from './blockFingerprint.js';

import type {
  BlockProvenance,
  DeletedBlockInfo,
  MarkdownProvenance,
} from '../../types/canvas/node.js';

/* ------------------------------------------------------------------ */
/* Construction / coercion                                             */
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
 * Type guard: validates that an unknown value matches the
 * `MarkdownProvenance` shape. Used to drop legacy block-id-keyed
 * payloads silently.
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
 * Coerce a possibly-legacy provenance value to the current shape.
 * Anything that is not a valid `MarkdownProvenance` becomes empty.
 */
export function coerceProvenance(value: unknown): MarkdownProvenance {
  return isMarkdownProvenance(value) ? value : emptyProvenance();
}

/* ------------------------------------------------------------------ */
/* Diff                                                                */
/* ------------------------------------------------------------------ */

/**
 * Diff two doc-key arrays. For each removed (old) key, also report the
 * surviving anchor key (the previous surviving block in the OLD
 * sequence), or `null` when there is no surviving predecessor.
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
/* Stamp                                                               */
/* ------------------------------------------------------------------ */

export interface StampInput {
  oldKeys: string[];
  newKeys: string[];
  /** Markdown for each old key (must contain entries for removed keys). */
  oldMarkdownByKey: Map<string, string>;
  /** ISO timestamp for the stamp (defaults to now). */
  at?: string;
}

/**
 * Apply an AI-edit diff to existing provenance.
 *
 * A block whose old fingerprint disappears and is replaced by a new one
 * in the SAME slot (same surrounding surviving blocks) is a
 * **modification**, not delete+insert. Unpaired leftovers become
 * inserts (`kind: 'inserted'`) or tombstones. Existing entries whose key
 * still appears are kept untouched.
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

  const keptBlocks: BlockProvenance[] = base.blocks.filter((b) =>
    newKeySet.has(b.key),
  );
  const keptKeySet = new Set(keptBlocks.map((b) => b.key));

  const newBlocks: BlockProvenance[] = [];

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

  for (const key of pureAdds) {
    if (keptKeySet.has(key)) continue;
    newBlocks.push({ key, kind: 'inserted', baselineMarkdown: '', at });
  }

  const liveAnchorSet = newKeySet;
  const keptTombstones: DeletedBlockInfo[] = base.deletedBlocks.filter(
    (t) => t.anchorKey === null || liveAnchorSet.has(t.anchorKey),
  );
  const keptTombKeys = new Set(keptTombstones.map((t) => t.key));

  const newTombstones: DeletedBlockInfo[] = [];
  for (const { key, anchorKey } of pureRemoves) {
    if (keptTombKeys.has(key)) continue;
    const baselineMarkdown = input.oldMarkdownByKey.get(key) ?? '';
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
 * one slot. Within each slot the first `min(removed, added)` pairs
 * become modifications; leftovers become pure removes / inserts.
 */
function pairAddRemoveBySlot(
  oldKeys: string[],
  newKeys: string[],
): {
  modifications: Array<{ removedKey: string; addedKey: string }>;
  pureAdds: string[];
  pureRemoves: Array<{ key: string; anchorKey: string | null }>;
} {
  const kept = longestCommonSubsequence(oldKeys, newKeys);
  const keptSet = new Set(kept);

  const modifications: Array<{ removedKey: string; addedKey: string }> = [];
  const pureAdds: string[] = [];
  const pureRemoves: Array<{ key: string; anchorKey: string | null }> = [];

  let oi = 0;
  let ni = 0;
  let prevAnchor: string | null = null;

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
      modifications.push({ removedKey: removedRun[i], addedKey: addedRun[i] });
    }
    for (let i = pairCount; i < removedRun.length; i++) {
      pureRemoves.push({ key: removedRun[i], anchorKey: prevAnchor });
    }
    for (let i = pairCount; i < addedRun.length; i++) {
      pureAdds.push(addedRun[i]);
    }

    if (anchor !== undefined) {
      if (oi < oldKeys.length && oldKeys[oi] === anchor) oi++;
      if (ni < newKeys.length && newKeys[ni] === anchor) ni++;
      prevAnchor = anchor;
    }
  }

  return { modifications, pureAdds, pureRemoves };
}

/** Standard O(N×M) longest common subsequence. */
function longestCommonSubsequence(a: string[], b: string[]): string[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];
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

/* ------------------------------------------------------------------ */
/* High-level: compute provenance for an AI note-content rewrite       */
/* ------------------------------------------------------------------ */

/**
 * Compute the new {@link MarkdownProvenance} for an AI edit that
 * rewrote a note's markdown from `oldContent` to `newContent`.
 *
 * Fingerprints both sides into ordered block keys (+ per-block markdown
 * for baselines) and folds the diff into `prev`. This is the single
 * entry point the server calls when an agent batch touches a note's
 * `content`; the result rides the node's `data.provenance` into the
 * delta broadcast, so every client renders identical attribution
 * without re-deriving anything locally.
 */
export function computeAiNoteProvenance(
  prev: MarkdownProvenance | undefined,
  oldContent: string,
  newContent: string,
  at?: string,
): MarkdownProvenance {
  const oldBlocks = fingerprintMarkdownBlocks(oldContent);
  const newBlocks = fingerprintMarkdownBlocks(newContent);
  return stampAiEdit(prev, {
    oldKeys: oldBlocks.map((b) => b.key),
    newKeys: newBlocks.map((b) => b.key),
    oldMarkdownByKey: new Map(oldBlocks.map((b) => [b.key, b.markdown])),
    ...(at ? { at } : {}),
  });
}

/* ------------------------------------------------------------------ */
/* User-edit shifting + accept / reject bookkeeping                    */
/* ------------------------------------------------------------------ */

/**
 * Recompute provenance against the live doc. Drops entries whose key
 * (or tombstone whose anchorKey) no longer exists. Called on every
 * user edit so edits naturally consume markers.
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

/** Drop one `BlockProvenance` entry by key. Markdown is unchanged. */
export function dropBlockEntry(
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
