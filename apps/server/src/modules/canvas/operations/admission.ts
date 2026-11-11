// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { SpaceOperationError } from '../../storage/ports/operations.js';

import type {
  SpaceOperationStore,
  SpaceOperationKey,
  SpaceOperationSnapshot,
  SpaceOperationWrite,
} from '../../storage/ports/operations.js';
import type { CanvasOperationReceipt } from '@huabu/shared';

/** Callers hold the Workspace lease and mutex; preparation must not write or run effects. */
export async function resolveOperationAlreadyLocked(
  operations: SpaceOperationStore,
  key: SpaceOperationKey,
  digest: string,
  prepare: (
    snapshot: SpaceOperationSnapshot,
  ) => SpaceOperationWrite | Promise<SpaceOperationWrite>,
): Promise<CanvasOperationReceipt> {
  const prior = await operations.lookup(key, digest);
  if (prior.status === 'terminal') return prior.receipt;
  if (prior.status === 'expired')
    throw new SpaceOperationError(
      'session-expired',
      'Operation session is unavailable or expired',
    );
  if (prior.status === 'pending')
    throw new SpaceOperationError(
      'operation-pending',
      'The operation outcome is not yet known',
    );
  const snapshot = await operations.readSnapshot();
  if (!snapshot)
    throw new SpaceOperationError(
      'collaboration-disabled',
      'This Space has no operation baseline',
    );
  const candidate = await prepare(snapshot);
  // Persistence uncertainty must not become a domain rejection or a new identity.
  return operations.commit(candidate);
}
