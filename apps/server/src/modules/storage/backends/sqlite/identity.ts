// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Allocation of the names a Space or Node is filed under.
 *
 * The `collision_key` columns carry a UNIQUE constraint, so a title or label
 * has to be de-duplicated before it reaches the database rather than after a
 * failed insert. These rules are pure and share `utils/naming` with Disk, so
 * both backends hand out the same ` (2)` suffixes for the same inputs — see
 * `backends/disk/space-title.ts` for the directory-locator half.
 */

import {
  dedupeName,
  normalizeForCompare,
  toSafeFilename,
} from '../../../../utils/naming.js';

import type { NodeContent } from '../../../canvas/persistence-types.js';

function allocatedSpaceTitle(
  requested: string | null,
  canvasId: string,
  allocatedName: string,
): string | null {
  if (requested === null) return null;
  const base = toSafeFilename(requested, canvasId);
  if (allocatedName === base) return requested;
  const candidate = `${requested}${allocatedName.slice(base.length)}`;
  return toSafeFilename(candidate, canvasId) === allocatedName
    ? candidate
    : allocatedName;
}

export function allocateSpaceIdentity(
  requestedTitle: string | null,
  canvasId: string,
  occupiedCollisionKeys: Iterable<string>,
): { readonly title: string | null; readonly collisionKey: string } {
  const base = toSafeFilename(requestedTitle, canvasId);
  const allocated = dedupeName(base, occupiedCollisionKeys);
  return {
    title: allocatedSpaceTitle(requestedTitle, canvasId, allocated),
    collisionKey: normalizeForCompare(allocated),
  };
}

export function collisionKeyForTitle(
  title: string | null,
  canvasId: string,
): string {
  return normalizeForCompare(toSafeFilename(title, canvasId));
}

export function allocateNodeIdentity(
  record: NodeContent,
  nodeId: string,
  existingCollisionKey: string | null,
  occupiedCollisionKeys: Iterable<string>,
): {
  readonly record: NodeContent;
  readonly collisionKey: string;
  readonly desiredCollisionKey: string;
} {
  const trimmedLabel =
    typeof record.label === 'string' && record.label.trim().length > 0
      ? record.label
      : null;
  if (trimmedLabel === null && existingCollisionKey !== null) {
    return {
      record,
      collisionKey: existingCollisionKey,
      desiredCollisionKey: existingCollisionKey,
    };
  }

  const desired = toSafeFilename(trimmedLabel, nodeId);
  const allocated = dedupeName(desired, occupiedCollisionKeys);
  const suffix =
    allocated.length > desired.length && allocated.startsWith(desired)
      ? allocated.slice(desired.length)
      : '';
  return {
    record:
      suffix && trimmedLabel
        ? { ...record, label: `${trimmedLabel}${suffix}` }
        : record,
    collisionKey: normalizeForCompare(allocated),
    desiredCollisionKey: normalizeForCompare(desired),
  };
}
