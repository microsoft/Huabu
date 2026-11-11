// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { SpaceWriteInput } from './structured.js';
import type {
  CanvasFile,
  NodeContent,
} from '../../canvas/persistence-types.js';
import type {
  CanvasCommitPage,
  CanvasCommitQuery,
  CanvasOperationLookup,
  CanvasOperationMetadata,
  CanvasOperationReceipt,
  CanvasOperationSession,
} from '@huabu/shared';
import type { CanvasChangeRecord } from '@huabu/shared/canvas-engine';

export interface SpaceOperationSnapshot {
  readonly record: CanvasFile;
  readonly metadata: CanvasOperationMetadata;
  /** Internal owner-service input, never part of structural HTTP/SSE replay. */
  readonly sidecars: Readonly<Record<string, NodeContent>>;
  readonly reviews: Readonly<Record<string, readonly CanvasChangeRecord[]>>;
}

export interface SpaceOperationKey {
  readonly spaceEpoch: string;
  readonly sessionId: string;
  readonly operationId: string;
  /** Authenticated scope, never read from a submitted origin. */
  readonly principalId: string;
}

export interface SpaceOperationWrite {
  readonly key: SpaceOperationKey;
  readonly digest: string;
  readonly expectedVersion: number;
  readonly receipt: CanvasOperationReceipt;
  /** Absent for rejection/no-op; no structural version increment. */
  readonly structure?: SpaceWriteInput;
  readonly metadata: CanvasOperationMetadata;
  readonly review: readonly {
    readonly threadId: string;
    readonly records: readonly CanvasChangeRecord[];
  }[];
}

/**
 * Internal storage boundary. No initialization/migration method is exposed:
 * production never creates an operation baseline, so every method answers
 * `collaboration-disabled`/absent for a Space without one.
 */
export interface SpaceOperationStore {
  readSnapshot(): Promise<SpaceOperationSnapshot | null>;
  createSession(principalId: string): Promise<CanvasOperationSession>;
  lookup(
    key: SpaceOperationKey,
    digest?: string,
  ): Promise<CanvasOperationLookup>;
  readCommits(query: CanvasCommitQuery): Promise<CanvasCommitPage>;
  /** Serializes lookup, lease check, head check and state/event/receipt/Review. */
  commit(input: SpaceOperationWrite): Promise<CanvasOperationReceipt>;
}

export class SpaceOperationError extends Error {
  override name = 'SpaceOperationError';
  constructor(
    readonly code:
      | 'collaboration-disabled'
      | 'operation-id-reused'
      | 'operation-pending'
      | 'session-expired'
      | 'session-forbidden'
      | 'stale-epoch'
      | 'head-conflict'
      | 'invalid-commit'
      | 'replay-corrupt'
      | 'commit-too-large'
      | 'replay-page-too-small',
    message: string,
  ) {
    super(message);
  }
}
