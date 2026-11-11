// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  canvasCommitQuerySchema,
  canvasOperationMetadataSchema,
  canvasOperationReceiptSchema,
  canvasOperationSessionSchema,
} from '@huabu/shared';

import { withImmediateTransaction } from './database.js';
import { readSpaceRow } from './rows.js';
import { writeSqliteSpaceInTransaction } from './space-write.js';
import { sanitizeId } from '../../../../utils/fs.js';
import {
  newOperationSession,
  operationReplayPage,
  validateOperationWrite,
} from '../../ports/operation-rules.js';
import { SpaceOperationError } from '../../ports/operations.js';
import { decodeNodeRecord, parseJson, stringifyJson } from '../sql/codecs.js';
import { decodeChanges } from '../sql/log-rules.js';

import type { SqliteStoreContext } from './database.js';
import type { NodeContent } from '../../../canvas/persistence-types.js';
import type {
  SpaceOperationKey,
  SpaceOperationSnapshot,
  SpaceOperationStore,
  SpaceOperationWrite,
} from '../../ports/operations.js';
import type {
  CanvasCommitQuery,
  CanvasOperationLookup,
  CanvasOperationReceipt,
  CanvasOperationSession,
} from '@huabu/shared';

export function createSqliteSpaceOperations(
  context: SqliteStoreContext,
  workspaceId: string,
  canvasId: string,
): SpaceOperationStore {
  const database = () => {
    context.assertBoundWorkspace(workspaceId, `Space operations(${canvasId})`);
    return context.database();
  };
  const snapshot = (): SpaceOperationSnapshot | null => {
    const db = database();
    const row = db
      .prepare(
        'SELECT metadata_json FROM operation_heads WHERE workspace_id = ? AND canvas_id = ?',
      )
      .get(workspaceId, canvasId);
    if (!row) return null;
    const record = readSpaceRow(db, workspaceId, canvasId)?.record;
    if (!record)
      throw new SpaceOperationError(
        'replay-corrupt',
        'Operation head has no Space',
      );
    const metadata = canvasOperationMetadataSchema.parse(
      parseJson(row['metadata_json'], 'Operation metadata'),
    );
    if (metadata.earliestReplayVersion > record.version)
      throw new SpaceOperationError(
        'replay-corrupt',
        'Replay floor exceeds the Space head',
      );
    const sidecars: Record<string, NodeContent> = {};
    for (const node of db
      .prepare('SELECT node_id, record_json FROM nodes WHERE canvas_id = ?')
      .all(canvasId)) {
      if (typeof node['node_id'] !== 'string')
        throw new SpaceOperationError(
          'replay-corrupt',
          'Invalid stored node ID',
        );
      sidecars[node['node_id']] = decodeNodeRecord(
        node['record_json'],
        node['node_id'],
      );
    }
    const reviews: Record<string, SpaceOperationSnapshot['reviews'][string]> =
      {};
    for (const row of db
      .prepare(
        'SELECT thread_id, snapshot_json FROM changes WHERE canvas_id = ?',
      )
      .all(canvasId)) {
      if (typeof row['thread_id'] !== 'string')
        throw new SpaceOperationError(
          'replay-corrupt',
          'Invalid Review thread ID',
        );
      reviews[row['thread_id']] = decodeChanges(
        row['snapshot_json'],
        canvasId,
        row['thread_id'],
      );
    }
    return { record, metadata, sidecars, reviews };
  };
  const requireSnapshot = () => {
    const current = snapshot();
    if (!current)
      throw new SpaceOperationError(
        'collaboration-disabled',
        'This Space has no operation baseline',
      );
    return current;
  };
  const requireDurableWriter = () => {
    context.assertMutationAllowed(canvasId);
    if (database().prepare('PRAGMA synchronous').get()?.['synchronous'] !== 2)
      throw new SpaceOperationError(
        'collaboration-disabled',
        'Operation storage requires SQLite synchronous=FULL',
      );
  };
  const session = (key: SpaceOperationKey): CanvasOperationSession | null => {
    const row = database()
      .prepare(
        `SELECT principal_id, session_json FROM operation_sessions
       WHERE workspace_id = ? AND canvas_id = ? AND space_epoch = ? AND session_id = ?`,
      )
      .get(workspaceId, canvasId, key.spaceEpoch, key.sessionId);
    if (!row) return null;
    if (row['principal_id'] !== key.principalId)
      throw new SpaceOperationError(
        'session-forbidden',
        'The session belongs to a different authenticated scope',
      );
    const value = canvasOperationSessionSchema.parse(
      parseJson(row['session_json'], 'Operation session'),
    );
    if (
      value.spaceEpoch !== key.spaceEpoch ||
      value.sessionId !== key.sessionId
    )
      throw new SpaceOperationError(
        'replay-corrupt',
        'Stored session identity mismatch',
      );
    return value;
  };
  const storedReceipt = (key: SpaceOperationKey) => {
    const row = database()
      .prepare(
        `SELECT digest, receipt_json FROM operation_receipts WHERE workspace_id = ?
       AND canvas_id = ? AND space_epoch = ? AND session_id = ? AND operation_id = ?`,
      )
      .get(
        workspaceId,
        canvasId,
        key.spaceEpoch,
        key.sessionId,
        key.operationId,
      );
    if (!row) return null;
    const receipt = canvasOperationReceiptSchema.parse(
      parseJson(row['receipt_json'], 'Operation receipt'),
    );
    if (
      receipt.spaceEpoch !== key.spaceEpoch ||
      receipt.sessionId !== key.sessionId ||
      receipt.operationId !== key.operationId
    )
      throw new SpaceOperationError(
        'replay-corrupt',
        'Stored receipt identity mismatch',
      );
    return { digest: row['digest'], receipt };
  };
  return {
    async readSnapshot() {
      return withImmediateTransaction(database(), snapshot);
    },
    async createSession(principalId: string) {
      if (!principalId)
        throw new SpaceOperationError(
          'session-forbidden',
          'Authenticated scope is required',
        );
      requireDurableWriter();
      return withImmediateTransaction(database(), () => {
        const current = requireSnapshot();
        const value = newOperationSession(
          current.metadata.spaceEpoch,
          context.now(),
        );
        database()
          .prepare(
            `INSERT INTO operation_sessions
           (workspace_id, canvas_id, space_epoch, session_id, principal_id, session_json)
           VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            workspaceId,
            canvasId,
            value.spaceEpoch,
            value.sessionId,
            principalId,
            stringifyJson(value, 'Operation session'),
          );
        return value;
      });
    },
    async lookup(
      key: SpaceOperationKey,
      digest?: string,
    ): Promise<CanvasOperationLookup> {
      return withImmediateTransaction(database(), () => {
        const lease = session(key);
        if (!lease) return { status: 'expired' };
        const existing = storedReceipt(key);
        if (existing) {
          if (digest !== undefined && existing.digest !== digest)
            throw new SpaceOperationError(
              'operation-id-reused',
              'Operation ID was already used for a different request',
            );
          return { status: 'terminal', receipt: existing.receipt };
        }
        if (
          lease.expiresAt <= context.now() ||
          snapshot()?.metadata.spaceEpoch !== key.spaceEpoch
        )
          return { status: 'expired' };
        return { status: 'absent' };
      });
    },
    async commit(input: SpaceOperationWrite): Promise<CanvasOperationReceipt> {
      requireDurableWriter();
      return withImmediateTransaction(database(), () => {
        const lease = session(input.key);
        if (!lease)
          throw new SpaceOperationError(
            'session-expired',
            'Operation session is unavailable',
          );
        const existing = storedReceipt(input.key);
        if (existing) {
          if (existing.digest !== input.digest)
            throw new SpaceOperationError(
              'operation-id-reused',
              'Operation ID was already used for a different request',
            );
          return existing.receipt;
        }
        if (lease.expiresAt <= context.now())
          throw new SpaceOperationError(
            'session-expired',
            'Operation session expired',
          );
        const current = requireSnapshot();
        validateOperationWrite(current, input);
        if (input.structure) {
          const result = writeSqliteSpaceInTransaction(
            database(),
            workspaceId,
            canvasId,
            input.structure,
          );
          if (!result.ok)
            throw new SpaceOperationError(
              'head-conflict',
              'Operation state write was refused',
            );
        }
        for (const review of input.review) {
          const threadId = sanitizeId(review.threadId, 'threadId');
          database()
            .prepare(
              `INSERT INTO changes (canvas_id, thread_id, snapshot_json) VALUES (?, ?, ?)
             ON CONFLICT(canvas_id, thread_id) DO UPDATE SET snapshot_json = excluded.snapshot_json`,
            )
            .run(
              canvasId,
              threadId,
              stringifyJson(review.records, 'Operation Review'),
            );
        }
        if (input.receipt.status === 'committed') {
          database()
            .prepare(
              `INSERT INTO operation_commits (workspace_id, canvas_id, space_epoch, version, commit_json)
             VALUES (?, ?, ?, ?, ?)`,
            )
            .run(
              workspaceId,
              canvasId,
              input.key.spaceEpoch,
              input.receipt.commitVersion,
              stringifyJson(input.receipt.commit, 'Operation commit'),
            );
        }
        if (input.receipt.status === 'committed') {
          database()
            .prepare(
              'UPDATE operation_heads SET metadata_json = ? WHERE workspace_id = ? AND canvas_id = ?',
            )
            .run(
              stringifyJson(input.metadata, 'Operation metadata'),
              workspaceId,
              canvasId,
            );
        }
        database()
          .prepare(
            `INSERT INTO operation_receipts
           (workspace_id, canvas_id, space_epoch, session_id, operation_id, digest, receipt_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            workspaceId,
            canvasId,
            input.key.spaceEpoch,
            input.key.sessionId,
            input.key.operationId,
            input.digest,
            stringifyJson(input.receipt, 'Operation receipt'),
          );
        return input.receipt;
      });
    },
    async readCommits(input: CanvasCommitQuery) {
      const query = canvasCommitQuerySchema.parse(input);
      return withImmediateTransaction(database(), () => {
        const current = requireSnapshot();
        const through = query.throughVersion ?? current.record.version;
        const rows = database()
          .prepare(
            `SELECT commit_json FROM operation_commits
           WHERE workspace_id = ? AND canvas_id = ? AND space_epoch = ?
             AND version > ? AND version <= ? ORDER BY version LIMIT ?`,
          )
          .all(
            workspaceId,
            canvasId,
            current.metadata.spaceEpoch,
            query.afterVersion,
            through,
            query.limit,
          );
        return operationReplayPage(
          current,
          query,
          rows.map((row) => parseJson(row['commit_json'], 'Operation commit')),
        );
      });
    },
  };
}
