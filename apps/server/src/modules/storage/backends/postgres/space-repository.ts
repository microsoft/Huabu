// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { randomUUID } from 'node:crypto';

import {
  decodeSpaceRow,
  insertSpaceRow,
  occupiedCollisionKeys,
  readSpaceRow,
  SPACE_COLUMNS,
} from './rows.js';
import { sanitizeId } from '../../../../utils/fs.js';
import {
  allocateSpaceIdentity,
  collisionKeyForTitle,
} from '../sql/identity.js';

import type { PgExecutor, PostgresStoreContext } from './database.js';
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

/**
 * Whether this Space id is taken anywhere in the database.
 *
 * Space ids are the primary key across every Workspace, so creation has to ask
 * globally even though everything else is scoped.
 */
async function spaceRowExistsAnywhere(
  database: PgExecutor,
  canvasId: string,
): Promise<boolean> {
  return (
    (
      await database.get(
        'SELECT 1 AS present FROM spaces WHERE canvas_id = ?',
        canvasId,
      )
    )?.['present'] === 1
  );
}

function validateTitle(title: unknown): asserts title is string | null {
  if (title !== null && typeof title !== 'string') {
    throw new TypeError('Space title must be a string or null');
  }
}

export class PostgresSpaceRepository implements SpaceRepository {
  readonly #context: PostgresStoreContext;
  readonly #workspaceId: string;

  constructor(context: PostgresStoreContext) {
    this.#context = context;
    // Bound at construction, like the Disk repository binds the workspace
    // path: one repository instance spans a caller's read and its follow-up
    // write, and a Workspace switch in between must reject rather than
    // silently retarget the write.
    this.#workspaceId = context.workspaceId();
  }

  /** The Workspace every query below is scoped to, re-checked per call. */
  #workspace(): string {
    return this.#context.assertBoundWorkspace(
      this.#workspaceId,
      'Postgres Space repository',
    );
  }

  async list(): Promise<CanvasSummary[]> {
    const workspaceId = this.#workspace();
    const database = this.#context.database();
    return (
      await database.all(
        `SELECT ${SPACE_COLUMNS}
         FROM spaces
         WHERE workspace_id = ? AND is_world = 0`,
        workspaceId,
      )
    ).map((row) => {
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
    const workspaceId = this.#workspace();
    const database = this.#context.database();
    const rows = await database.all(
      `SELECT ${SPACE_COLUMNS}
         FROM spaces
         WHERE workspace_id = ? AND is_world = 1`,
      workspaceId,
    );
    if (rows.length !== 1) {
      throw new Error(
        rows.length === 0
          ? 'Postgres namespace has no World Space'
          : 'Postgres namespace has multiple World Spaces',
      );
    }
    const world = decodeSpaceRow(rows[0]);
    if (!world.isWorld) throw new Error('Postgres World Space is malformed');
    return sanitizeId(world.record.canvasId, 'world canvasId');
  }

  async ensureWorld(): Promise<string> {
    const workspaceId = this.#workspace();
    return await this.#context.transaction(async (database) => {
      const existing = await database.all(
        `SELECT ${SPACE_COLUMNS}
           FROM spaces
           WHERE workspace_id = ? AND is_world = 1`,
        workspaceId,
      );
      if (existing.length > 1) {
        throw new Error('Postgres namespace has multiple World Spaces');
      }
      if (existing.length === 1) {
        const world = decodeSpaceRow(existing[0]);
        if (!world.isWorld)
          throw new Error('Postgres World Space is malformed');
        return sanitizeId(world.record.canvasId, 'world canvasId');
      }

      const canvasId = randomUUID();
      const timestamp = this.#context.now();
      if (!Number.isFinite(timestamp)) {
        throw new TypeError('Postgres Space clock returned a non-finite value');
      }
      await insertSpaceRow(
        database,
        workspaceId,
        {
          canvasId,
          title: 'World',
          version: 0,
          state: { nodes: [], edges: [] },
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        '',
        true,
      );
      return canvasId;
    });
  }

  async create(input: SpaceCreateInput): Promise<SpaceCreateResult> {
    const canvasId = sanitizeId(input.canvasId, 'canvasId');
    validateTitle(input.title);
    const workspaceId = this.#workspace();
    this.#context.assertMutationAllowed(canvasId);

    return await this.#context.transaction(async (database) => {
      // Existence is checked across every Workspace, not just the active one:
      // `canvas_id` is the primary key, so an id already used elsewhere is
      // taken here too, and reporting it as free would fail on INSERT.
      if (await spaceRowExistsAnywhere(database, canvasId)) {
        return { ok: false as const, reason: 'already-exists' as const };
      }
      const identity = allocateSpaceIdentity(
        input.title,
        canvasId,
        await occupiedCollisionKeys(database, workspaceId),
      );
      const timestamp = this.#context.now();
      if (!Number.isFinite(timestamp)) {
        throw new TypeError('Postgres Space clock returned a non-finite value');
      }
      const record: CanvasFile = {
        canvasId,
        title: identity.title,
        version: 0,
        state: { nodes: [], edges: [] },
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await insertSpaceRow(
        database,
        workspaceId,
        record,
        identity.collisionKey,
      );
      return { ok: true as const, record };
    });
  }

  async beginDelete(input: SpaceDeleteInput): Promise<SpaceBeginDeleteResult> {
    const canvasId = sanitizeId(input.canvasId, 'canvasId');
    const workspaceId = this.#workspace();
    const beforeAdmission = await readSpaceRow(
      this.#context.database(),
      workspaceId,
      canvasId,
    );
    if (beforeAdmission?.isWorld) {
      return { ok: false, reason: 'world-forbidden' };
    }

    this.#workspace();
    const release = await this.#context.acquireDelete(canvasId);
    let sessionOwnsGate = false;
    try {
      this.#workspace();
      const afterAdmission = await readSpaceRow(
        this.#context.database(),
        workspaceId,
        canvasId,
      );
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
            this.#workspace();
            const result = await this.#context.transaction(async (database) => {
              const current = await readSpaceRow(
                database,
                workspaceId,
                canvasId,
              );
              if (current?.isWorld) {
                throw new Error(`Refusing to delete World Space ${canvasId}`);
              }
              if (current === null) {
                return {
                  deleted: false,
                };
              }
              const deleted = Number(
                (
                  await database.run(
                    'DELETE FROM spaces WHERE workspace_id = ? AND canvas_id = ?',
                    workspaceId,
                    canvasId,
                  )
                ).changes,
              );
              return { deleted: deleted === 1 };
            });
            if (result.deleted)
              return { ok: true as const, reason: 'deleted' as const };
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
            this.#workspace();
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
    const workspaceId = this.#workspace();
    this.#context.assertMutationAllowed(canvasId);

    return await this.#context.transaction(async (database) => {
      const current = await readSpaceRow(database, workspaceId, canvasId);
      if (current === null) return { ok: false, reason: 'not-found' } as const;
      if (current.isWorld) {
        return { ok: false, reason: 'world-forbidden' } as const;
      }
      if (current.record.title === input.title) {
        return { ok: true, record: current.record } as const;
      }

      const collisionKey = collisionKeyForTitle(input.title, canvasId);
      if (collisionKey !== current.collisionKey) {
        const conflict = await database.get(
          `SELECT ${SPACE_COLUMNS}
             FROM spaces
             WHERE workspace_id = ? AND collision_key = ? AND canvas_id <> ?`,
          workspaceId,
          collisionKey,
          canvasId,
        );
        if (conflict !== undefined) {
          return {
            ok: false,
            reason: 'title-conflict',
            conflictingTitle: decodeSpaceRow(conflict).record.title,
          } as const;
        }
      }

      const result = await database.run(
        `UPDATE spaces
           SET title = ?, collision_key = ?
           WHERE workspace_id = ? AND canvas_id = ?`,
        input.title,
        collisionKey,
        workspaceId,
        canvasId,
      );
      if (Number(result.changes) !== 1) {
        throw new Error(`Could not rename Postgres Space ${canvasId}`);
      }
      return {
        ok: true,
        record: { ...current.record, title: input.title },
      } as const;
    });
  }
}
