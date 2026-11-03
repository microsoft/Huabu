// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Pool } from 'pg';

/**
 * Each person's current Workspace, in Bubble mode.
 *
 * Huabu's own record about a Bubble principal, referencing its `principalId`
 * as #228 proposes, so Bubble stays the only account directory. It lives in
 * the Postgres Bubble already requires, in a schema of its own, whatever
 * backend holds Huabu's content.
 */
export interface WorkspacePreferences {
  current(principalId: string): Promise<string | null>;
  select(principalId: string, workspaceId: string): Promise<void>;
  close(): Promise<void>;
}

const SCHEMA = 'huabu_identity';

export async function openPostgresWorkspacePreferences(
  url: string,
): Promise<WorkspacePreferences> {
  const pool = new Pool({ connectionString: url, max: 2 });
  pool.on('error', () => {});
  try {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${SCHEMA}.current_workspaces (
        principal_id text PRIMARY KEY,
        workspace_id text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`,
    );
  } catch (error) {
    await pool.end();
    throw error;
  }
  return {
    async current(principalId) {
      const { rows } = await pool.query<{ workspace_id: string }>(
        `SELECT workspace_id FROM ${SCHEMA}.current_workspaces WHERE principal_id = $1`,
        [principalId],
      );
      return rows[0]?.workspace_id ?? null;
    },
    async select(principalId, workspaceId) {
      await pool.query(
        `INSERT INTO ${SCHEMA}.current_workspaces (principal_id, workspace_id)
         VALUES ($1, $2)
         ON CONFLICT (principal_id)
         DO UPDATE SET workspace_id = EXCLUDED.workspace_id, updated_at = now()`,
        [principalId, workspaceId],
      );
    },
    close: () => pool.end(),
  };
}

/** For tests and single-process use without a database. */
export function createMemoryWorkspacePreferences(): WorkspacePreferences {
  const current = new Map<string, string>();
  return {
    current: async (principalId) => current.get(principalId) ?? null,
    select: async (principalId, workspaceId) => {
      current.set(principalId, workspaceId);
    },
    close: async () => {},
  };
}
