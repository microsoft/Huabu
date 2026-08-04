/**
 * Backend-neutral persistence DTOs for a Space.
 *
 * These describe *what* is persisted, not *how*: the Space record, a node's
 * canonical markdown content, a behavioural event, and one headless-executor
 * delta batch. They are owned by the Canvas domain rather than by a storage
 * adapter so a storage **port** can reference them without importing a
 * backend — the dependency rule in
 * docs/proposals/multi-backend-storage.md §12.2.1.
 *
 * Nothing here may grow a filesystem-shaped field (a path, a filename, a
 * directory handle). Those belong to the Disk adapter.
 */

import type {
  CanvasEventRecord,
  ExecuteOriginator,
} from '@sediment/shared';

/** On-disk shape of `<canvasDir>/space.json`. */
export interface CanvasFile {
  canvasId: string;
  title: string | null;
  version: number;
  state: {
    nodes: unknown[];
    edges: unknown[];
    [key: string]: unknown;
  };
  createdAt: number;
  updatedAt: number;
}

/** Canonical content of a single node markdown file. */
export interface NodeContent {
  nodeId: string;
  type: string;
  /**
   * Display label shown on the canvas (`data.label` at runtime). Persisted
   * as `label:` in the markdown frontmatter.
   */
  label: string | null;
  /**
   * External URL or `artifacts/<file>` reference. Optional: only meaningful
   * for source-backed nodes (web/pdf/image/audio/video). Note/text/frame
   * nodes omit it entirely so it never lands in their frontmatter.
   */
  src?: string;
  /** Canonical markdown body. */
  content: string;
  /** Loader/enrich-supplied frontmatter fields (summary, keywords, …). */
  [key: string]: unknown;
}

/** Append-only behavioural event for a canvas (re-export of shared schema). */
export type CanvasEvent = CanvasEventRecord;

/**
 * One row in `<canvasDir>/.history/delta-log.jsonl` — the persisted
 * trace of a single headless-executor batch (M2).
 *
 * Field names are chosen so a future SQLite migration can use them
 * verbatim as column names (the planned `delta_log` table mirrors this
 * shape 1:1). The `command` and `deltas` fields stay opaque (`unknown`)
 * at the storage layer; the engine owns their schema in
 * `@sediment/shared/canvas-engine/delta`.
 */
export interface DeltaLogEntry {
  /** Canvas version this batch landed at — also the row's primary key. */
  version: number;
  /** Wall-clock time of the append (server clock). */
  ts: number;
  /** Optional run id; multiple rows can share one runId in M3 batches. */
  runId?: string;
  /** Annotated commands the executor actually applied (origin/labelSource stamped). */
  commands: unknown[];
  /** Coarse `Delta[]` produced by diffing prestate → poststate. */
  deltas: unknown[];
  originator: ExecuteOriginator;
}
