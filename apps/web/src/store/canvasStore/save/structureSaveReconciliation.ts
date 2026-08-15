// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export interface CanvasVersionReconciliation {
  version: number;
  conflictResolved: boolean;
}

/**
 * Reconcile an acknowledged server version without allowing an older HTTP
 * response to roll back a version already advanced by Canvas Sync.
 */
export function reconcileCanvasVersion(
  currentVersion: number,
  acknowledgedVersion: number,
  conflictServerVersion: number | null,
): CanvasVersionReconciliation {
  const version = Math.max(currentVersion, acknowledgedVersion);
  return {
    version,
    conflictResolved:
      conflictServerVersion !== null && version >= conflictServerVersion,
  };
}

/**
 * A version-conflict response is stale when another channel has already
 * advanced the client to the server version reported by that response.
 */
export function isCoveredCanvasVersionConflict(
  currentVersion: number,
  serverVersion: number | undefined,
): boolean {
  return serverVersion !== undefined && currentVersion >= serverVersion;
}
