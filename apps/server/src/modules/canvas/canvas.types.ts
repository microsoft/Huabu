/**
 * Canvas Module Internal Types
 *
 * Internal types used within the canvas module (canvas.route.ts, canvas.migration.ts).
 * These are not exported to the frontend – for frontend-facing types,
 * see @sediment/shared/types/canvas.
 */

/**
 * Canvas database row structure.
 * Represents a canvas record as stored in SQLite.
 */
export type CanvasRow = {
  canvasId: string;
  workspaceId: string | null;
  title: string | null;
  version: number;
  stateJson: string;
  createdAt: number;
  updatedAt: number;
};

/**
 * Loose node type for processing unknown/untyped node structures.
 * Used when iterating over canvas state before validation.
 */
export interface NodeLike {
  type?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}
