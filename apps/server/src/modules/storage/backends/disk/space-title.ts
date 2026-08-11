// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Disk-only mapping between logical Space titles and directory locators. */

import {
  normalizeForCompare,
  toSafeFilename,
} from '../../../workspace/disk/naming.js';

function isDedupeVariant(filename: string, base: string): boolean {
  const normalizedFilename = normalizeForCompare(filename);
  const normalizedBase = normalizeForCompare(base);
  if (!normalizedFilename.startsWith(`${normalizedBase} (`)) return false;
  if (!normalizedFilename.endsWith(')')) return false;
  const suffix = normalizedFilename.slice(normalizedBase.length + 2, -1);
  const ordinal = Number(suffix);
  return (
    Number.isInteger(ordinal) && ordinal >= 2 && String(ordinal) === suffix
  );
}

/**
 * Return the logical title that a newly allocated directory can round-trip.
 * Ordinary suffixes preserve the caller's punctuation; lossy trim/truncation
 * falls back to the physical name. A null title always remains null.
 */
export function titleForAllocatedDirectory(
  requested: string | null,
  canvasId: string,
  directoryName: string,
): string | null {
  if (requested === null) return null;
  const base = toSafeFilename(requested, canvasId);
  if (directoryName === base) return requested;
  const candidate = `${requested}${directoryName.slice(base.length)}`;
  return toSafeFilename(candidate, canvasId) === directoryName
    ? candidate
    : directoryName;
}

/**
 * Reconcile a persisted logical title with its current directory locator.
 * A de-duplicated locator allocated for a null title is not a Finder rename.
 */
export function titleVisibleAtDirectory(
  persisted: string | null,
  canvasId: string,
  directoryName: string,
): string | null {
  const expectedDirectory = toSafeFilename(persisted, canvasId);
  if (persisted === null && isDedupeVariant(directoryName, expectedDirectory)) {
    return null;
  }
  if (persisted === directoryName) return persisted;
  return directoryName && directoryName !== expectedDirectory
    ? directoryName
    : persisted;
}
