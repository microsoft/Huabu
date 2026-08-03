/**
 * Structured storage port — domain records, not opaque bytes.
 *
 * The connection ({@link StructuredStore}) owns backend identity and
 * lifecycle, and vends a handle per Space.
 *
 * Scope note: {@link SpaceHandle} is `CanvasStore` today. That makes this a
 * real lifecycle and backend-selection boundary but *not yet* a
 * backend-neutral data contract — a SQLite or Postgres adapter cannot be
 * written against this interface as it stands. Narrowing `SpaceHandle` into
 * asynchronous repositories (`SpaceRepository`, `NodeRepository`,
 * `CanvasEventRepository`) is the next phase; see
 * docs/proposals/multi-backend-storage.md §6.1 and §14.
 *
 * What this port *does* deliver now is the separation itself: blob bytes
 * are no longer reachable through it, so no single interface mixes the two
 * concerns.
 */

import type { CanvasStore } from '../canvas-store.js';
import type { StorageHealth } from './common.js';

export type StructuredBackendKind = 'disk' | 'sqlite' | 'postgres';

/**
 * Structured records for one Space.
 *
 * Aliased rather than redeclared: pretending this is already abstract
 * would overclaim. The alias marks every consumer that a later phase must
 * revisit.
 */
export type SpaceHandle = CanvasStore;

/** A connection to a structured backend. Process-wide; handles are derived. */
export interface StructuredStore {
  readonly kind: StructuredBackendKind;
  init(): Promise<void>;
  health(): Promise<StorageHealth>;
  close(): Promise<void>;
  space(canvasId: string): SpaceHandle;
}
