// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Journal-backed Disk ownership of Space catalogue membership. */

import path from 'node:path';

import { forgetCanvasStore } from './legacy/canvas-store-cache.js';
import { clearSpaceNodeTombstones } from './legacy/node-tombstones.js';
import {
  abortPreparedDiskTransaction,
  applyPreparedDiskTransaction,
  finalizeCommittedDiskTransaction,
  finalizeCommittedDiskTransactionBestEffort,
  isPreparedDiskTransactionCommitted,
  markPreparedDiskTransactionCommitted,
  prepareDiskTransaction,
  withDiskTransactionWorkspaceLock,
} from './transaction-journal.js';
import { sanitizeId } from '../../../../utils/fs.js';
import { createKeyedMutex } from '../../../../utils/keyed-mutex.js';
import {
  isWorldCanvasId,
  listAllCanvasDirEntries,
  listCanvasDirEntries,
  refreshCanvasDirIndex,
  suggestCanvasDir,
} from '../../../workspace/disk/canvas-dirs.js';
import { toSafeFilename } from '../../../workspace/disk/naming.js';
import { SPACE_JSON_FILENAME } from '../../../workspace/disk/paths.js';
import { getWorkspacePath } from '../../../workspace.js';

import type {
  PrepareDiskTransactionInput,
  PreparedDiskTransaction,
} from './transaction-journal.js';
import type { CanvasFile } from '../../../canvas/persistence-types.js';
import type {
  SpaceCreateInput,
  SpaceCreateResult,
  SpaceDeleteInput,
  SpaceDeleteResult,
  SpaceLifecycleRepository,
} from '../../ports/structured.js';

/** Injectable only so adapter failure tests can stop at journal boundaries. */
export interface DiskLifecycleJournal {
  prepare(input: PrepareDiskTransactionInput): PreparedDiskTransaction;
  apply(handle: PreparedDiskTransaction): void;
  markCommitted(handle: PreparedDiskTransaction): void;
  finalize(handle: PreparedDiskTransaction): void;
  abort(handle: PreparedDiskTransaction): void;
}

const defaultJournal: DiskLifecycleJournal = {
  prepare: prepareDiskTransaction,
  apply: applyPreparedDiskTransaction,
  markCommitted: markPreparedDiskTransactionCommitted,
  finalize: finalizeCommittedDiskTransaction,
  abort: abortPreparedDiskTransaction,
};

const withLifecycleMutex = createKeyedMutex<string>();

function transactionKey(workspacePath: string, canvasId: string): string {
  return `${workspacePath}\0${canvasId}`;
}

function jsonBytes(value: unknown): Buffer {
  // Keep the byte shape used by atomicWriteJson so lifecycle-created records
  // do not acquire a formatting-only diff on their first real commit.
  return Buffer.from(JSON.stringify(value, null, 2), 'utf8');
}

function effectiveTitle(
  requested: string | null,
  canvasId: string,
  directoryName: string,
): string | null {
  const base = toSafeFilename(requested, canvasId);
  if (directoryName === base) return requested;
  if (requested === null) return directoryName;
  return `${requested}${directoryName.slice(base.length)}`;
}

/**
 * Complete one prepared lifecycle transaction or restore its before-state.
 * Cleanup after the marker is best-effort and retried by Workspace-gated
 * recovery; a committed decision must never be rolled back or reported as a
 * failed lifecycle operation.
 */
function runPrepared(
  journal: DiskLifecycleJournal,
  transaction: PreparedDiskTransaction,
): void {
  let committed = false;
  try {
    journal.apply(transaction);
    try {
      journal.markCommitted(transaction);
    } catch (error) {
      // A failure injected immediately after the atomic marker rename is not
      // an operation failure: the durable decision wins over the call stack.
      if (!isPreparedDiskTransactionCommitted(transaction)) throw error;
    }
    committed = true;
    finalizeCommittedDiskTransactionBestEffort(transaction, (handle) =>
      journal.finalize(handle),
    );
  } catch (error) {
    if (!committed) {
      try {
        journal.abort(transaction);
      } catch {
        // If the marker landed immediately before an injected/process-local
        // failure, recovery owns the now-committed journal. Preserve the
        // operation's original error instead of pretending it was rolled back.
      }
    }
    throw error;
  }
}

export class DiskSpaceLifecycleRepository implements SpaceLifecycleRepository {
  readonly #workspacePath = path.resolve(getWorkspacePath());

  constructor(
    private readonly journal: DiskLifecycleJournal = defaultJournal,
    private readonly now: () => number = Date.now,
    private readonly clearNodeTombstones: (
      workspacePath: string,
      canvasId: string,
    ) => void = clearSpaceNodeTombstones,
  ) {}

  create(input: SpaceCreateInput): Promise<SpaceCreateResult> {
    const canvasId = sanitizeId(input.canvasId, 'canvasId');
    return withLifecycleMutex(
      transactionKey(this.#workspacePath, canvasId),
      () =>
        withDiskTransactionWorkspaceLock(this.#workspacePath, async () => {
          this.assertActiveWorkspace();
          refreshCanvasDirIndex();
          if (
            listAllCanvasDirEntries().some((entry) => entry.id === canvasId)
          ) {
            return { ok: false, reason: 'already-exists' };
          }

          const directoryName = suggestCanvasDir(input.title, canvasId);
          const title = effectiveTitle(input.title, canvasId, directoryName);
          const timestamp = this.now();
          const record: CanvasFile = {
            canvasId,
            title,
            version: 0,
            state: { nodes: [], edges: [] },
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          const transaction = this.journal.prepare({
            workspacePath: this.#workspacePath,
            directory: { kind: 'create', rootRelativePath: directoryName },
            files: [
              {
                relativePath: SPACE_JSON_FILENAME,
                before: null,
                after: jsonBytes(record),
              },
            ],
          });
          runPrepared(this.journal, transaction);

          // The directory itself is the Disk catalogue membership row. Rescan
          // only after the commit decision so readers cannot observe a member
          // whose v0 record has not landed.
          refreshCanvasDirIndex();
          return { ok: true, record, effectiveTitle: title };
        }),
    );
  }

  delete(input: SpaceDeleteInput): Promise<SpaceDeleteResult> {
    const canvasId = sanitizeId(input.canvasId, 'canvasId');
    return withLifecycleMutex(
      transactionKey(this.#workspacePath, canvasId),
      async () => {
        this.assertActiveWorkspace();
        refreshCanvasDirIndex();
        if (isWorldCanvasId(canvasId)) {
          return { ok: false, reason: 'world-forbidden' };
        }

        let entry = listCanvasDirEntries().find(
          (candidate) => candidate.id === canvasId,
        );

        // Preserve the blob-first retryable saga even for an already-missing
        // structured record: the hook may be cleaning orphaned bytes from an
        // earlier partial failure. World was rejected before this point.
        await input.beforeRemove?.();
        this.assertActiveWorkspace();

        return withDiskTransactionWorkspaceLock(
          this.#workspacePath,
          async () => {
            // Direct port callers need the same post-await protection as the
            // composition service. A Finder delete, or another process, may
            // have removed the root while blob cleanup was in flight.
            refreshCanvasDirIndex();
            entry = listCanvasDirEntries().find(
              (candidate) => candidate.id === canvasId,
            );
            if (!entry) {
              forgetCanvasStore(canvasId);
              return { ok: false, reason: 'not-found' };
            }

            const transaction = this.journal.prepare({
              workspacePath: this.#workspacePath,
              directory: {
                kind: 'quarantine',
                rootRelativePath: entry.filename,
              },
            });
            runPrepared(this.journal, transaction);

            // Quarantine + COMMITTED is the durable delete decision. Cache,
            // tombstone, and directory-index cleanup are maintenance only;
            // none may turn a completed delete into an API failure. Every
            // successor lifecycle operation refreshes the index again.
            try {
              forgetCanvasStore(canvasId);
            } catch {
              // Best-effort process-local cache cleanup.
            }
            try {
              this.clearNodeTombstones(this.#workspacePath, canvasId);
            } catch {
              // Tombstones expire independently and are safe to retain.
            }
            try {
              refreshCanvasDirIndex();
            } catch {
              // A later catalogue operation retries the scan.
            }
            return { ok: true, reason: 'deleted' };
          },
        );
      },
    );
  }

  private assertActiveWorkspace(): void {
    if (path.resolve(getWorkspacePath()) === this.#workspacePath) return;
    throw new Error(
      'Space lifecycle repository belongs to an inactive workspace. Resolve a fresh lifecycle handle.',
    );
  }
}
