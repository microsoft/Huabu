// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The SQLite schema, and the rule for changing it.
 *
 * One file per version, applied in order, never edited once released. The
 * migration runner in `database.ts` enforces that shape; this file is only the
 * SQL. Everything is `STRICT` so a column's declared type is a real
 * constraint, and every child row reaches its owner through a foreign key so
 * deleting a Space or a Workspace cannot leave the rest behind.
 *
 * Two collections sit at the top: Workspaces, which are the namespaces a
 * deployment holds, and Spaces, which belong to exactly one of them. That is
 * the whole reason a SQL profile needs no Workspace directory — a Workspace is
 * a row, not a folder, and switching to another one re-scopes queries through
 * the same connection rather than reopening anything (proposal §2, "Backend
 * selection scope").
 *
 * Nothing here holds bytes. Blobs are files on whichever file system the blob
 * axis names, so a Space's uploads, artifacts, guide and memory body are never
 * rows in this database; the two lifecycles are joined only by the deletion
 * saga in `storage.ts`, which sweeps the byte areas before the record goes.
 */

/**
 * Version 1 — Workspaces, Spaces, and everything a Space owns.
 *
 * `collision_key` is the de-duplicated, case-folded name a Space or node is
 * filed under. It exists because titles and labels collide and the product
 * resolves that with " (2)" suffixes; the UNIQUE constraints are what make
 * the allocation in `identity.ts` authoritative rather than advisory.
 */
const SCHEMA_V1 = `
  CREATE TABLE workspaces (
    workspace_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at REAL NOT NULL,
    last_opened_at REAL NOT NULL,
    -- Membership is forgettable without being destructive: the port's
    -- remove() drops a Workspace from the listing and keeps everything it
    -- owns, the way forgetting a Disk Workspace leaves its folder on disk.
    forgotten_at REAL
  ) STRICT;

  CREATE TABLE spaces (
    canvas_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    title TEXT,
    collision_key TEXT NOT NULL,
    version INTEGER NOT NULL,
    state_json TEXT NOT NULL CHECK (json_valid(state_json)),
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    is_world INTEGER NOT NULL DEFAULT 0 CHECK (is_world IN (0, 1)),
    UNIQUE (workspace_id, collision_key),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id)
      ON DELETE CASCADE
  ) STRICT;

  CREATE UNIQUE INDEX spaces_single_world
    ON spaces(workspace_id)
    WHERE is_world = 1;

  CREATE TABLE nodes (
    canvas_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    record_json TEXT NOT NULL CHECK (json_valid(record_json)),
    revision TEXT NOT NULL CHECK (length(revision) > 0),
    label_collision_key TEXT NOT NULL,
    PRIMARY KEY (canvas_id, node_id),
    UNIQUE (canvas_id, label_collision_key),
    FOREIGN KEY (canvas_id) REFERENCES spaces(canvas_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    canvas_id TEXT NOT NULL,
    event_json TEXT NOT NULL CHECK (json_valid(event_json)),
    FOREIGN KEY (canvas_id) REFERENCES spaces(canvas_id) ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX events_by_canvas_order
    ON events(canvas_id, event_id);

  CREATE TABLE changes (
    canvas_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
    PRIMARY KEY (canvas_id, thread_id),
    FOREIGN KEY (canvas_id) REFERENCES spaces(canvas_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE tasks (
    canvas_id TEXT PRIMARY KEY,
    snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
    FOREIGN KEY (canvas_id) REFERENCES spaces(canvas_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE space_extensions (
    extension_id INTEGER PRIMARY KEY AUTOINCREMENT,
    canvas_id TEXT NOT NULL,
    namespace TEXT NOT NULL,
    UNIQUE (canvas_id, namespace),
    FOREIGN KEY (canvas_id) REFERENCES spaces(canvas_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE delta_log (
    canvas_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    entry_json TEXT NOT NULL CHECK (json_valid(entry_json)),
    PRIMARY KEY (canvas_id, version),
    FOREIGN KEY (canvas_id) REFERENCES spaces(canvas_id) ON DELETE CASCADE
  ) STRICT;
`;

export interface SqliteMigration {
  readonly version: number;
  readonly sql: string;
}

export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = Object.freeze([
  Object.freeze({ version: 1, sql: SCHEMA_V1 }),
  Object.freeze({
    version: 2,
    sql: `
      ALTER TABLE spaces ADD COLUMN parent_space_id TEXT;
      ALTER TABLE spaces ADD COLUMN parent_entry_node_id TEXT;
      CREATE INDEX spaces_by_parent ON spaces(workspace_id, parent_space_id);
    `,
  }),
  Object.freeze({
    version: 3,
    sql: `
      CREATE TABLE operation_heads (
        workspace_id TEXT NOT NULL,
        canvas_id TEXT NOT NULL PRIMARY KEY,
        metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
        FOREIGN KEY (canvas_id) REFERENCES spaces(canvas_id) ON DELETE CASCADE
      ) STRICT;
      CREATE TABLE operation_sessions (
        workspace_id TEXT NOT NULL,
        canvas_id TEXT NOT NULL,
        space_epoch TEXT NOT NULL,
        session_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        session_json TEXT NOT NULL CHECK (json_valid(session_json)),
        PRIMARY KEY (workspace_id, canvas_id, space_epoch, session_id),
        FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
      ) STRICT;
      CREATE TABLE operation_receipts (
        workspace_id TEXT NOT NULL,
        canvas_id TEXT NOT NULL,
        space_epoch TEXT NOT NULL,
        session_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        digest TEXT NOT NULL,
        receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
        PRIMARY KEY (workspace_id, canvas_id, space_epoch, session_id, operation_id),
        FOREIGN KEY (workspace_id, canvas_id, space_epoch, session_id)
          REFERENCES operation_sessions(workspace_id, canvas_id, space_epoch, session_id)
      ) STRICT;
      CREATE TABLE operation_commits (
        workspace_id TEXT NOT NULL,
        canvas_id TEXT NOT NULL,
        space_epoch TEXT NOT NULL,
        version INTEGER NOT NULL,
        commit_json TEXT NOT NULL CHECK (json_valid(commit_json)),
        PRIMARY KEY (workspace_id, canvas_id, space_epoch, version),
        FOREIGN KEY (canvas_id) REFERENCES spaces(canvas_id) ON DELETE CASCADE
      ) STRICT;
    `,
  }),
  // The work_json column is unused. The migration is retained only so that
  // databases which already ran it keep opening.
  Object.freeze({
    version: 4,
    sql: `ALTER TABLE operation_heads ADD COLUMN work_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(work_json));`,
  }),
]);

export const SQLITE_SCHEMA_VERSION =
  SQLITE_MIGRATIONS[SQLITE_MIGRATIONS.length - 1]?.version ?? 0;
