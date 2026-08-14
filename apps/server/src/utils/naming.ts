// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Pure naming primitives shared by storage adapters and filesystem views. */

import path from 'node:path';

// eslint-disable-next-line no-control-regex
const ILLEGAL_CHARS_RE = /[\\/:*?"<>|\x00-\x1F]/g;
const WIN_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export const MAX_FILENAME_LENGTH = 120;

/**
 * Normalize a logical label into the collision key used by today's Disk
 * layout. SQL adapters use the same pure rule so title and label allocation
 * remain portable without importing a filesystem backend.
 */
export function toSafeFilename(
  name?: string | null,
  fallback = 'Untitled',
): string {
  const normalized = (name ?? '').normalize('NFC');
  let safe = normalized.replace(ILLEGAL_CHARS_RE, '_');
  safe = safe.replace(/^[.\s]+|[.\s]+$/g, '');
  if (!safe) return fallback;
  if (WIN_RESERVED_RE.test(safe)) safe = `_${safe}`;
  if (safe.length > MAX_FILENAME_LENGTH) {
    safe = safe.slice(0, MAX_FILENAME_LENGTH);
  }
  return safe;
}

/** Case-insensitive + NFC-normalized comparison key. */
export function normalizeForCompare(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/** Append " (2)", " (3)", … on collision. Case-insensitive. */
export function dedupeName(base: string, existing: Iterable<string>): string {
  const taken = new Set<string>();
  for (const name of existing) taken.add(normalizeForCompare(name));
  if (!taken.has(normalizeForCompare(base))) return base;
  let i = 2;
  while (taken.has(normalizeForCompare(`${base} (${i})`))) i += 1;
  return `${base} (${i})`;
}

/** Like {@link dedupeName} but preserves the file extension. */
export function dedupeArtifactFilename(
  filename: string,
  existing: Iterable<string>,
): string {
  const ext = path.extname(filename);
  const stem = ext ? filename.slice(0, -ext.length) : filename;
  const stemTaken = new Set<string>();
  for (const name of existing) {
    const otherExt = path.extname(name);
    const otherStem = otherExt ? name.slice(0, -otherExt.length) : name;
    stemTaken.add(normalizeForCompare(otherStem));
  }
  if (!stemTaken.has(normalizeForCompare(stem))) return filename;
  let i = 2;
  while (stemTaken.has(normalizeForCompare(`${stem} (${i})`))) i += 1;
  return `${stem} (${i})${ext}`;
}
