-- Immutable SQLite structured-store schema v1 fixture.
-- Add a new fixture for later schema versions; do not rewrite this history.

PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;

CREATE TABLE spaces (
  canvas_id TEXT PRIMARY KEY,
  title TEXT,
  collision_key TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL,
  is_world INTEGER NOT NULL DEFAULT 0 CHECK (is_world IN (0, 1))
) STRICT;

CREATE UNIQUE INDEX spaces_single_world
  ON spaces(is_world)
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

INSERT INTO spaces (
  canvas_id, title, collision_key, version, state_json,
  created_at, updated_at, is_world
) VALUES (
  'fixture-world', 'World', '.world', 0,
  '{"nodes":[],"edges":[]}', 1, 1, 1
);

INSERT INTO spaces (
  canvas_id, title, collision_key, version, state_json,
  created_at, updated_at, is_world
) VALUES (
  'fixture-space', 'Fixture Space', 'fixture space', 3,
  '{"nodes":[{"id":"fixture-node","type":"note"}],"edges":[]}',
  10, 13, 0
);

INSERT INTO nodes (
  canvas_id, node_id, record_json, revision, label_collision_key
) VALUES (
  'fixture-space', 'fixture-node',
  '{"nodeId":"fixture-node","type":"note","label":"Fixture Node","content":"fixture body"}',
  'fixture-revision', 'fixture node'
);

INSERT INTO events (canvas_id, event_json) VALUES (
  'fixture-space',
  '{"payload":{"action":"node_selected","node":{"id":"fixture-node","type":"note","label":"Fixture Node"}},"ts":12}'
);

INSERT INTO changes (canvas_id, thread_id, snapshot_json) VALUES (
  'fixture-space', 'fixture-thread', '[]'
);

INSERT INTO tasks (canvas_id, snapshot_json) VALUES (
  'fixture-space', '{"version":1,"tasks":[],"runs":[]}'
);

INSERT INTO delta_log (canvas_id, version, entry_json) VALUES (
  'fixture-space', 3,
  '{"version":3,"ts":13,"commands":[],"deltas":[],"originator":{"source":"system"}}'
);

PRAGMA user_version = 1;
COMMIT;
