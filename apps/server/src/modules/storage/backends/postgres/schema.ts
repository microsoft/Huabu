// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Immutable PostgreSQL v1 migration. SQL dialect/version history belongs to the adapter.
const SCHEMA_V1 = `
  CREATE TABLE workspaces (
    workspace_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at DOUBLE PRECISION NOT NULL,
    last_opened_at DOUBLE PRECISION NOT NULL,
    -- Membership is forgettable without being destructive: the port's
    -- remove() drops a Workspace from the listing and keeps everything it
    -- owns, the way forgetting a Disk Workspace leaves its folder on disk.
    forgotten_at DOUBLE PRECISION
  );

  CREATE TABLE spaces (
    canvas_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    title TEXT,
    collision_key TEXT NOT NULL,
    version INTEGER NOT NULL,
    state_json TEXT NOT NULL CHECK ((state_json::json) IS NOT NULL),
    created_at DOUBLE PRECISION NOT NULL,
    updated_at DOUBLE PRECISION NOT NULL,
    is_world INTEGER NOT NULL DEFAULT 0 CHECK (is_world IN (0, 1)),
    UNIQUE (workspace_id, collision_key),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id)
      ON DELETE CASCADE
  );

  CREATE UNIQUE INDEX spaces_single_world
    ON spaces(workspace_id)
    WHERE is_world = 1;

  CREATE TABLE nodes (
    canvas_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    record_json TEXT NOT NULL CHECK ((record_json::json) IS NOT NULL),
    revision TEXT NOT NULL CHECK (length(revision) > 0),
    label_collision_key TEXT NOT NULL,
    PRIMARY KEY (canvas_id, node_id),
    UNIQUE (canvas_id, label_collision_key),
    FOREIGN KEY (canvas_id) REFERENCES spaces(canvas_id) ON DELETE CASCADE
  );

  CREATE TABLE events (
    event_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    canvas_id TEXT NOT NULL,
    event_json TEXT NOT NULL CHECK ((event_json::json) IS NOT NULL),
    FOREIGN KEY (canvas_id) REFERENCES spaces(canvas_id) ON DELETE CASCADE
  );

  CREATE INDEX events_by_canvas_order
    ON events(canvas_id, event_id);

  CREATE TABLE changes (
    canvas_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    snapshot_json TEXT NOT NULL CHECK ((snapshot_json::json) IS NOT NULL),
    PRIMARY KEY (canvas_id, thread_id),
    FOREIGN KEY (canvas_id) REFERENCES spaces(canvas_id) ON DELETE CASCADE
  );

  CREATE TABLE tasks (
    canvas_id TEXT PRIMARY KEY,
    snapshot_json TEXT NOT NULL CHECK ((snapshot_json::json) IS NOT NULL),
    FOREIGN KEY (canvas_id) REFERENCES spaces(canvas_id) ON DELETE CASCADE
  );

  CREATE TABLE space_extensions (
    extension_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    canvas_id TEXT NOT NULL,
    namespace TEXT NOT NULL,
    UNIQUE (canvas_id, namespace),
    FOREIGN KEY (canvas_id) REFERENCES spaces(canvas_id) ON DELETE CASCADE
  );

  CREATE TABLE delta_log (
    canvas_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    entry_json TEXT NOT NULL CHECK ((entry_json::json) IS NOT NULL),
    PRIMARY KEY (canvas_id, version),
    FOREIGN KEY (canvas_id) REFERENCES spaces(canvas_id) ON DELETE CASCADE
  );
`;

export const POSTGRES_MIGRATIONS = [
  { version: 1, sql: SCHEMA_V1 },
  {
    version: 2,
    sql: `
      ALTER TABLE spaces ADD COLUMN parent_space_id TEXT;
      ALTER TABLE spaces ADD COLUMN parent_entry_node_id TEXT;
      CREATE INDEX spaces_by_parent ON spaces(workspace_id, parent_space_id);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE operation_heads (
        workspace_id TEXT NOT NULL,
        canvas_id TEXT NOT NULL PRIMARY KEY,
        metadata_json TEXT NOT NULL CHECK ((metadata_json::json) IS NOT NULL),
        FOREIGN KEY (canvas_id) REFERENCES spaces(canvas_id) ON DELETE CASCADE
      );
      CREATE TABLE operation_sessions (
        workspace_id TEXT NOT NULL,
        canvas_id TEXT NOT NULL,
        space_epoch TEXT NOT NULL,
        session_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        session_json TEXT NOT NULL CHECK ((session_json::json) IS NOT NULL),
        PRIMARY KEY (workspace_id, canvas_id, space_epoch, session_id),
        FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
      );
      CREATE TABLE operation_receipts (
        workspace_id TEXT NOT NULL,
        canvas_id TEXT NOT NULL,
        space_epoch TEXT NOT NULL,
        session_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        digest TEXT NOT NULL,
        receipt_json TEXT NOT NULL CHECK ((receipt_json::json) IS NOT NULL),
        PRIMARY KEY (workspace_id, canvas_id, space_epoch, session_id, operation_id),
        FOREIGN KEY (workspace_id, canvas_id, space_epoch, session_id)
          REFERENCES operation_sessions(workspace_id, canvas_id, space_epoch, session_id)
      );
      CREATE TABLE operation_commits (
        workspace_id TEXT NOT NULL,
        canvas_id TEXT NOT NULL,
        space_epoch TEXT NOT NULL,
        version BIGINT NOT NULL,
        commit_json TEXT NOT NULL CHECK ((commit_json::json) IS NOT NULL),
        PRIMARY KEY (workspace_id, canvas_id, space_epoch, version),
        FOREIGN KEY (canvas_id) REFERENCES spaces(canvas_id) ON DELETE CASCADE
      );
    `,
  },
  // The work_json column is unused. The migration is retained only so that
  // databases which already ran it keep opening.
  {
    version: 4,
    sql: `ALTER TABLE operation_heads ADD COLUMN work_json TEXT NOT NULL DEFAULT '{}' CHECK ((work_json::json) IS NOT NULL);`,
  },
  // Reliable save: per-Space version stamps and per-request result records.
  // Both hang off the Space row, so they follow it through rename and
  // re-parenting and are removed with it.
  {
    version: 5,
    sql: `
      CREATE TABLE space_save_heads (
        canvas_id TEXT PRIMARY KEY,
        lineage TEXT NOT NULL,
        floor INTEGER NOT NULL,
        stamps_json TEXT NOT NULL CHECK ((stamps_json::json) IS NOT NULL),
        FOREIGN KEY (canvas_id) REFERENCES spaces(canvas_id) ON DELETE CASCADE
      );
      CREATE TABLE space_save_results (
        canvas_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        digest TEXT NOT NULL,
        at_version INTEGER NOT NULL,
        created_at DOUBLE PRECISION NOT NULL,
        response_json TEXT NOT NULL CHECK ((response_json::json) IS NOT NULL),
        PRIMARY KEY (canvas_id, principal_id, operation_id),
        FOREIGN KEY (canvas_id) REFERENCES spaces(canvas_id) ON DELETE CASCADE
      );
      CREATE INDEX space_save_results_by_age
        ON space_save_results(canvas_id, created_at);
    `,
  },
] as const;
