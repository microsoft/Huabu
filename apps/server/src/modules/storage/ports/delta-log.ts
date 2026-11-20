// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Bounds of the delta log, shared by every backend.
 *
 * The log is a journal of recent writes. The application never reads it —
 * only Disk crash recovery asks for its last row — so it is kept short:
 *
 * - **Rows.** A Space keeps the rows of its newest
 *   {@link DELTA_LOG_MAX_ROWS} versions. SQLite and PostgreSQL delete what is
 *   older in the write that adds a row (one indexed range delete). Disk,
 *   whose log is one append-only file, rewrites the file to its newest half
 *   when it reaches the limit, so it holds between half and all of them.
 * - **Bytes.** A row is stored whole only up to
 *   {@link DELTA_LOG_ROW_MAX_BYTES}; a larger one keeps its header and says
 *   what was left out (`omitted`). With the row limit that bounds a Space's
 *   log at rows × row size on every backend; on Disk the file is in addition
 *   never left above {@link DELTA_LOG_FILE_MAX_BYTES}.
 *
 * Each check costs the same whatever the log holds: a size comparison of
 * the new row, one range delete, or a `stat` and a 64-byte read.
 */

import type { DeltaLogEntry } from '../../canvas/persistence-types.js';

/** Newest versions whose rows a Space keeps. */
export const DELTA_LOG_MAX_ROWS = 200;

/** Largest row stored whole. */
export const DELTA_LOG_ROW_MAX_BYTES = 64 * 1024;

/** Disk: the size at which the log file is cut to its newest part. */
export const DELTA_LOG_FILE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The row as it is stored: `entry` itself, or — when it would be larger than
 * a row may be — its header with `deltas` and `commands` left out and a note
 * of how much that was.
 */
export function boundedDeltaLogEntry(entry: DeltaLogEntry): DeltaLogEntry {
  const bytes = Buffer.byteLength(JSON.stringify(entry), 'utf8');
  if (bytes <= DELTA_LOG_ROW_MAX_BYTES) return entry;
  return {
    version: entry.version,
    ts: entry.ts,
    ...(entry.runId ? { runId: entry.runId } : {}),
    commands: [],
    deltas: [],
    originator: entry.originator,
    omitted: {
      bytes,
      commands: entry.commands.length,
      deltas: entry.deltas.length,
    },
  };
}
