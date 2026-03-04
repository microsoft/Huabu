/**
 * ONE-TIME MIGRATION: Convert legacy string `origin` values to the new
 * discriminated-object format ({ type: '…' }).
 *
 * Runs automatically on server startup. Safe to re-run (idempotent).
 *
 * @removable Delete this entire file (and its call-site in canvas.db.ts)
 *            once all environments have been migrated.
 */

import { normalizeOrigin } from '@sediment/shared';

import type Database from 'better-sqlite3';

interface CanvasRow {
  canvasId: string;
  stateJson: string;
}

interface CanvasState {
  nodes: CanvasNode[];
  edges: unknown[];
}

interface CanvasNode {
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Walk every canvas in the database and convert any node whose `origin` is
 * still a plain string into the `{ type: … }` object form.
 *
 * The migration is wrapped in a single transaction so it either fully
 * succeeds or fully rolls back.
 */
export function migrateNodeOrigins(db: Database.Database): void {
  const rows = db
    .prepare('SELECT canvasId, stateJson FROM canvases')
    .all() as CanvasRow[];

  const update = db.prepare(
    'UPDATE canvases SET stateJson = ? WHERE canvasId = ?',
  );

  const runMigration = db.transaction(() => {
    let migrated = 0;

    for (const row of rows) {
      let state: CanvasState;
      try {
        state = JSON.parse(row.stateJson) as CanvasState;
      } catch {
        // Skip rows with unparseable JSON
        continue;
      }

      if (!Array.isArray(state.nodes)) continue;

      let changed = false;

      for (const node of state.nodes) {
        if (!node.data) continue;
        const raw = node.data.origin;
        if (raw === undefined || raw === null) continue;

        // Already migrated — skip
        if (typeof raw === 'object') continue;

        const converted = normalizeOrigin(raw);
        if (converted) {
          node.data.origin = converted;
          changed = true;
        }
      }

      if (changed) {
        update.run(JSON.stringify(state), row.canvasId);
        migrated += 1;
      }
    }

    return migrated;
  });

  const count = runMigration();
  if (count > 0) {
    console.log(
      `[origin-migration] Migrated ${String(count)} canvas(es) to object-based origins.`,
    );
  }
}
