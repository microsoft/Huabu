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

export const POSTGRES_MIGRATIONS = [{ version: 1, sql: SCHEMA_V1 }] as const;
