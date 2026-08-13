// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { withImmediateTransaction } from './database.js';
import {
  allocateSpaceIdentity,
  collisionKeyForTitle,
  decodeSpaceRow,
  insertSpaceRow,
  readSpaceRow,
  SPACE_COLUMNS,
} from './values.js';
import { sanitizeId } from '../../../../utils/fs.js';

import type { SqliteStoreContext } from './database.js';
import type { CanvasFile } from '../../../canvas/persistence-types.js';
import type {
  SpaceBeginDeleteResult,
  SpaceCreateInput,
  SpaceCreateResult,
  SpaceDeleteInput,
  SpaceDeleteSession,
  SpaceRenameInput,
  SpaceRenameResult,
  SpaceRepository,
} from '../../ports/structured.js';
import type { CanvasSummary } from '@huabu/shared';

function validateTitle(title: unknown): asserts title is string | null {
  if (title !== null && typeof title !== 'string') {
    throw new TypeError('Space title must be a string or null');
  }
}

export class SqliteSpaceRepository implements SpaceRepository {
  readonly #context: SqliteStoreContext;

  constructor(context: SqliteStoreContext) {
    this.#context = context;
  }

  async list(): Promise<CanvasSummary[]> {
    const database = this.#context.database();
    return database
      .prepare(`SELECT ${SPACE_COLUMNS} FROM spaces WHERE is_world = 0`)
      .all()
      .map((row) => {
        const { record } = decodeSpaceRow(row);
        return {
          canvasId: record.canvasId,
          title: record.title,
          nodeCount: record.state.nodes.length,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        };
      });
  }

  async worldId(): Promise<string> {
    const database = this.#context.database();
    const rows = database
      .prepare(`SELECT ${SPACE_COLUMNS} FROM spaces WHERE is_world = 1`)
      .all();
    if (rows.length !== 1) {
      throw new Error(
        rows.length === 0
          ? 'SQLite namespace has no World Space'
          : 'SQLite namespace has multiple World Spaces',
      );
    }
    const world = decodeSpaceRow(rows[0]);
    if (!world.isWorld) throw new Error('SQLite World Space is malformed');
    return sanitizeId(world.record.canvasId, 'world canvasId');
  }

  async create(input: SpaceCreateInput): Promise<SpaceCreateResult> {
    const canvasId = sanitizeId(input.canvasId, 'canvasId');
    validateTitle(input.title);
    this.#context.assertMutationAllowed(canvasId);
    const database = this.#context.database();

    return withImmediateTransaction(database, () => {
      if (readSpaceRow(database, canvasId) !== null) {
        return { ok: false as const, reason: 'already-exists' as const };
      }
      const occupied = database
        .prepare('SELECT collision_key FROM spaces')
        .all()
        .map((row) => row['collision_key'])
        .filter((value): value is string => typeof value === 'string');
      const identity = allocateSpaceIdentity(input.title, canvasId, occupied);
      const timestamp = this.#context.now();
      if (!Number.isFinite(timestamp)) {
        throw new TypeError('SQLite Space clock returned a non-finite value');
      }
      const record: CanvasFile = {
        canvasId,
        title: identity.title,
        version: 0,
        state: { nodes: [], edges: [] },
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      insertSpaceRow(database, record, identity.collisionKey);
      return { ok: true as const, record };
    });
  }

  async beginDelete(input: SpaceDeleteInput): Promise<SpaceBeginDeleteResult> {
    const canvasId = sanitizeId(input.canvasId, 'canvasId');
    const beforeAdmission = readSpaceRow(this.#context.database(), canvasId);
    if (beforeAdmission?.isWorld) {
      return { ok: false, reason: 'world-forbidden' };
    }

    const release = await this.#context.acquireDelete(canvasId);
    let sessionOwnsGate = false;
    try {
      const afterAdmission = readSpaceRow(this.#context.database(), canvasId);
      if (afterAdmission?.isWorld) {
        return { ok: false, reason: 'world-forbidden' };
      }

      let state: 'open' | 'finishing' | 'closed' = 'open';
      const close = (): void => {
        if (state === 'closed') return;
        state = 'closed';
        release();
      };
      const session: SpaceDeleteSession = Object.freeze({
        finish: async () => {
          if (state !== 'open') {
            throw new Error(`Space deletion session for ${canvasId} is closed`);
          }
          state = 'finishing';
          try {
            this.#context.assertOpen();
            const database = this.#context.database();
            const result = withImmediateTransaction(database, () => {
              const current = readSpaceRow(database, canvasId);
              if (current?.isWorld) {
                throw new Error(`Refusing to delete World Space ${canvasId}`);
              }
              if (current === null) {
                return {
                  deleted: false,
                };
              }
              const deleted = Number(
                database
                  .prepare('DELETE FROM spaces WHERE canvas_id = ?')
                  .run(canvasId).changes,
              );
              return { deleted: deleted === 1 };
            });
            if (result.deleted) {
              this.#context.clearCanvasTombstones(canvasId);
              return { ok: true as const, reason: 'deleted' as const };
            }
            return { ok: false as const, reason: 'not-found' as const };
          } finally {
            close();
          }
        },
        abort: async () => {
          if (state === 'finishing') {
            throw new Error(
              `Space deletion session for ${canvasId} is already finishing`,
            );
          }
          if (state === 'closed') return;
          try {
            this.#context.assertOpen();
          } finally {
            close();
          }
        },
      });
      sessionOwnsGate = true;
      return { ok: true, session };
    } finally {
      if (!sessionOwnsGate) release();
    }
  }

  async rename(input: SpaceRenameInput): Promise<SpaceRenameResult> {
    const canvasId = sanitizeId(input.canvasId, 'canvasId');
    validateTitle(input.title);
    this.#context.assertMutationAllowed(canvasId);
    const database = this.#context.database();

    return withImmediateTransaction(database, () => {
      const current = readSpaceRow(database, canvasId);
      if (current === null) return { ok: false, reason: 'not-found' } as const;
      if (current.isWorld) {
        return { ok: false, reason: 'world-forbidden' } as const;
      }
      if (current.record.title === input.title) {
        return { ok: true, record: current.record } as const;
      }

      const collisionKey = collisionKeyForTitle(input.title, canvasId);
      if (collisionKey !== current.collisionKey) {
        const conflict = database
          .prepare(
            `SELECT ${SPACE_COLUMNS}
             FROM spaces
             WHERE collision_key = ? AND canvas_id <> ?`,
          )
          .get(collisionKey, canvasId);
        if (conflict !== undefined) {
          return {
            ok: false,
            reason: 'title-conflict',
            conflictingTitle: decodeSpaceRow(conflict).record.title,
          } as const;
        }
      }

      const result = database
        .prepare(
          `UPDATE spaces
           SET title = ?, collision_key = ?
           WHERE canvas_id = ?`,
        )
        .run(input.title, collisionKey, canvasId);
      if (Number(result.changes) !== 1) {
        throw new Error(`Could not rename SQLite Space ${canvasId}`);
      }
      return {
        ok: true,
        record: { ...current.record, title: input.title },
      } as const;
    });
  }
}
