// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  dedupeName,
  normalizeForCompare,
  toSafeFilename,
} from '../../../utils/naming.js';

import type { NodeContent } from '../../canvas/persistence-types.js';

/** Allocate a portable sidecar label before preparing any backend's commit. */
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
