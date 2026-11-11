// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  canvasCommitQuerySchema,
  canvasOperationMetadataSchema,
  canvasOperationReceiptSchema,
  canvasOperationSessionSchema,
} from '@huabu/shared';

import { readSpaceRow } from './rows.js';
import { writePostgresSpaceInTransaction } from './space-write.js';
import { sanitizeId } from '../../../../utils/fs.js';
import {
  newOperationSession,
  operationReplayPage,
  validateOperationWrite,
} from '../../ports/operation-rules.js';
import { SpaceOperationError } from '../../ports/operations.js';
import { decodeNodeRecord, parseJson, stringifyJson } from '../sql/codecs.js';
import { decodeChanges } from '../sql/log-rules.js';

import type { PgExecutor, PostgresStoreContext } from './database.js';
import type { NodeContent } from '../../../canvas/persistence-types.js';
import type {
  SpaceOperationKey,
  SpaceOperationSnapshot,
  SpaceOperationStore,
} from '../../ports/operations.js';
import type { CanvasOperationLookup } from '@huabu/shared';

/** All statements share the existing advisory-locked transaction and its one checked-out client. */
export function createPostgresSpaceOperations(
  context: PostgresStoreContext,
  workspaceId: string,
  canvasId: string,
): SpaceOperationStore {
  const transaction = <T>(action: (db: PgExecutor) => Promise<T>) => {
    context.assertBoundWorkspace(workspaceId, `Space operations(${canvasId})`);
    return context.transaction(action);
  };
  const snapshot = async (
    db: PgExecutor,
  ): Promise<SpaceOperationSnapshot | null> => {
    const head = await db.get(
      'SELECT metadata_json FROM operation_heads WHERE workspace_id = ? AND canvas_id = ?',
      workspaceId,
      canvasId,
    );
    if (!head) return null;
    const record = (await readSpaceRow(db, workspaceId, canvasId))?.record;
    if (!record)
      throw new SpaceOperationError(
        'replay-corrupt',
        'Operation head has no Space',
      );
    const metadata = canvasOperationMetadataSchema.parse(
      parseJson(head['metadata_json'], 'Operation metadata'),
    );
    if (metadata.earliestReplayVersion > record.version)
      throw new SpaceOperationError(
        'replay-corrupt',
        'Replay floor exceeds the Space head',
      );
    const sidecars: Record<string, NodeContent> = {};
    for (const row of await db.all(
      'SELECT node_id, record_json FROM nodes WHERE canvas_id = ?',
      canvasId,
    )) {
      if (typeof row['node_id'] !== 'string')
        throw new SpaceOperationError(
          'replay-corrupt',
          'Invalid stored node ID',
        );
      sidecars[row['node_id']] = decodeNodeRecord(
        row['record_json'],
        row['node_id'],
      );
    }
    const reviews: Record<string, SpaceOperationSnapshot['reviews'][string]> =
      {};
    for (const row of await db.all(
      'SELECT thread_id, snapshot_json FROM changes WHERE canvas_id = ?',
      canvasId,
    )) {
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
  const requireSnapshot = async (db: PgExecutor) => {
    const current = await snapshot(db);
    if (!current)
      throw new SpaceOperationError(
        'collaboration-disabled',
        'This Space has no operation baseline',
      );
    return current;
  };
  const requireDurableWriter = async (db: PgExecutor) => {
    context.assertMutationAllowed(canvasId);
    await db.run('SET LOCAL synchronous_commit = on');
    const settings = await db.get(`SELECT current_setting('fsync') AS fsync,
      current_setting('full_page_writes') AS full_page_writes,
      current_setting('synchronous_commit') AS synchronous_commit`);
    if (
      settings?.['fsync'] !== 'on' ||
      settings['full_page_writes'] !== 'on' ||
      settings['synchronous_commit'] !== 'on'
    )
      throw new SpaceOperationError(
        'collaboration-disabled',
        'PostgreSQL durable commit settings are required',
      );
  };
  const lease = async (db: PgExecutor, key: SpaceOperationKey) => {
    const row = await db.get(
      `SELECT principal_id, session_json FROM operation_sessions
      WHERE workspace_id = ? AND canvas_id = ? AND space_epoch = ? AND session_id = ?`,
      workspaceId,
      canvasId,
      key.spaceEpoch,
      key.sessionId,
    );
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
  const lookup = async (
    db: PgExecutor,
    key: SpaceOperationKey,
    digest?: string,
  ): Promise<CanvasOperationLookup> => {
    const session = await lease(db, key);
    if (!session) return { status: 'expired' };
    const row = await db.get(
      `SELECT digest, receipt_json FROM operation_receipts
      WHERE workspace_id = ? AND canvas_id = ? AND space_epoch = ? AND session_id = ? AND operation_id = ?`,
      workspaceId,
      canvasId,
      key.spaceEpoch,
      key.sessionId,
      key.operationId,
    );
    if (row) {
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
      if (digest !== undefined && row['digest'] !== digest)
        throw new SpaceOperationError(
          'operation-id-reused',
          'Operation ID was already used for a different request',
        );
      return { status: 'terminal', receipt };
    }
    if (
      session.expiresAt <= context.now() ||
      (await snapshot(db))?.metadata.spaceEpoch !== key.spaceEpoch
    )
      return { status: 'expired' };
    return { status: 'absent' };
  };
  return {
    readSnapshot: () => transaction(snapshot),
    createSession: (principalId) =>
      transaction(async (db) => {
        if (!principalId)
          throw new SpaceOperationError(
            'session-forbidden',
            'Authenticated scope is required',
          );
        await requireDurableWriter(db);
        const current = await requireSnapshot(db);
        const session = newOperationSession(
          current.metadata.spaceEpoch,
          context.now(),
        );
        await db.run(
          `INSERT INTO operation_sessions
        (workspace_id, canvas_id, space_epoch, session_id, principal_id, session_json) VALUES (?, ?, ?, ?, ?, ?)`,
          workspaceId,
          canvasId,
          session.spaceEpoch,
          session.sessionId,
          principalId,
          stringifyJson(session, 'Operation session'),
        );
        return session;
      }),
    lookup: (key, digest) => transaction((db) => lookup(db, key, digest)),
    commit: (input) =>
      transaction(async (db) => {
        await requireDurableWriter(db);
        const prior = await lookup(db, input.key, input.digest);
        if (prior.status === 'terminal') return prior.receipt;
        if (prior.status !== 'absent')
          throw new SpaceOperationError(
            'session-expired',
            'Operation session is unavailable or expired',
          );
        const current = await requireSnapshot(db);
        validateOperationWrite(current, input);
        if (input.structure) {
          const result = await writePostgresSpaceInTransaction(
            db,
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
        for (const review of input.review)
          await db.run(
            `INSERT INTO changes (canvas_id, thread_id, snapshot_json) VALUES (?, ?, ?)
          ON CONFLICT(canvas_id, thread_id) DO UPDATE SET snapshot_json = excluded.snapshot_json`,
            canvasId,
            sanitizeId(review.threadId, 'threadId'),
            stringifyJson(review.records, 'Operation Review'),
          );
        if (input.receipt.status === 'committed') {
          await db.run(
            `INSERT INTO operation_commits (workspace_id, canvas_id, space_epoch, version, commit_json)
          VALUES (?, ?, ?, ?, ?)`,
            workspaceId,
            canvasId,
            input.key.spaceEpoch,
            input.receipt.commitVersion,
            stringifyJson(input.receipt.commit, 'Operation commit'),
          );
        }
        if (input.receipt.status === 'committed') {
          await db.run(
            'UPDATE operation_heads SET metadata_json = ? WHERE workspace_id = ? AND canvas_id = ?',
            stringifyJson(input.metadata, 'Operation metadata'),
            workspaceId,
            canvasId,
          );
        }
        await db.run(
          `INSERT INTO operation_receipts
        (workspace_id, canvas_id, space_epoch, session_id, operation_id, digest, receipt_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
          workspaceId,
          canvasId,
          input.key.spaceEpoch,
          input.key.sessionId,
          input.key.operationId,
          input.digest,
          stringifyJson(input.receipt, 'Operation receipt'),
        );
        // COMMIT failures propagate from context.transaction. Lookup on a fresh
        // connection resolves uncertainty; never retry the candidate here.
        return input.receipt;
      }),
    readCommits: (raw) =>
      transaction(async (db) => {
        const query = canvasCommitQuerySchema.parse(raw);
        const current = await requireSnapshot(db);
        const rows = await db.all(
          `SELECT commit_json FROM operation_commits
        WHERE workspace_id = ? AND canvas_id = ? AND space_epoch = ? AND version > ? AND version <= ?
        ORDER BY version LIMIT ?`,
          workspaceId,
          canvasId,
          current.metadata.spaceEpoch,
          query.afterVersion,
          query.throughVersion ?? current.record.version,
          query.limit,
        );
        return operationReplayPage(
          current,
          query,
          rows.map((row) => parseJson(row['commit_json'], 'Operation commit')),
        );
      }),
  };
}
