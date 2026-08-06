// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Legacy PM-JSON block fingerprinter for the Milkdown editor.
 *
 * The host-agnostic provenance algebra (diff / stamp / shift / accept /
 * reject) now lives in `@huabu/shared/canvas-engine`
 * (`provenance/noteProvenance.ts`) so the server can compute provenance
 * authoritatively for AI edits. This module keeps ONLY the ProseMirror-
 * coupled fingerprinter that derives a stable key from a live PM node's
 * `toJSON()` structure, plus a re-export of the shared algebra so
 * existing editor-side imports keep working.
 *
 * NOTE: the PM-JSON fingerprinter is being superseded by the shared
 * mdast fingerprint (`fingerprintMarkdownBlocks`), which the server and
 * client both agree on. It remains here for the editor's current block
 * lookup path and is removed once the editor switches over.
 */

// ── Re-exported host-agnostic provenance algebra ──────────────────────────
export {
  emptyProvenance,
  isMarkdownProvenance,
  coerceProvenance,
  diffBlocks,
  stampAiEdit,
  computeAiNoteProvenance,
  shiftProvenance,
  dropBlockEntry,
  dismissDeletedBlock,
  acceptAll,
  findBlockEntry,
  findTombstonesAfter,
  type StampInput,
} from '@huabu/shared/canvas-engine';

/* ------------------------------------------------------------------ */
/* Snapshot type                                                       */
/* ------------------------------------------------------------------ */

/**
 * Structural projection of a top-level ProseMirror block. Callers obtain
 * one of these from `node.toJSON()`. Keep it deliberately loose — any
 * extra attrs the schema adds are absorbed by the index signature.
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
