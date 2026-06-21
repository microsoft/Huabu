/**
 * Canvas search API types.
 *
 * Streaming full-text search across all nodes in a single canvas.
 * Implemented over plain HTTP with an NDJSON-framed response body
 * (`application/x-ndjson`) so the server can emit fast metadata hits
 * (label / summary / keywords) immediately, then content-body hits as
 * soon as the per-node sidecar scan finishes. The client consumes the
 * stream incrementally so the first matches show up before the heavier
 * content scan completes.
 *
 * Wire shape:
 *
 *   POST /api/canvas/:canvasId/search
 *     body: CanvasSearchRequest (JSON)
 *     200 : Content-Type: application/x-ndjson
 *           one JSON object per line (CanvasSearchEvent)
 *
 * No batching, no `[`/`]` envelope — each line is independently parseable.
 * Client closes the connection (`AbortController.abort()`) to cancel a
 * superseded query; the server short-circuits its scan loop on close.
 */

import { z } from 'zod';

// ─── Field tiers ───────────────────────────────────────────────────────────

/**
 * Which fields of a node a match was found in. Tiered by scan cost so
 * the server can stream the cheap tier first.
 *
 *  - `label`     — node.data.label (always present, tiny)
 *  - `summary`   — sidecar frontmatter `summary:` (one-line AI summary)
 *  - `keywords`  — sidecar frontmatter `keywords:` (string[])
 *  - `content`   — sidecar markdown body (the heavy one)
 */
export const searchFieldSchema = z.enum([
  'label',
  'summary',
  'keywords',
  'content',
]);
export type SearchField = z.infer<typeof searchFieldSchema>;

/** First three are the "metadata tier" — fast, in-memory only. */
export const META_SEARCH_FIELDS: readonly SearchField[] = [
  'label',
  'summary',
  'keywords',
];

// ─── Request ───────────────────────────────────────────────────────────────

export const canvasSearchRequestSchema = z.object({
  /** Search needle. Treated as a literal (case-insensitive) substring. */
  query: z.string().min(1).max(200),
  /**
   * Cap on matches per tier. Defaults to 50. Hard upper bound 500 so
   * a malicious / runaway query can't pin the server. Client paginates
   * by re-issuing with a narrower query, not by offset.
   */
  limit: z.number().int().positive().max(500).optional(),
  /**
   * Restrict scan to a subset of node types (e.g. `['note', 'text']`).
   * Empty / omitted means "all types". Useful for the in-preview search
   * bar which only ever cares about the currently-open node type.
   */
  nodeTypes: z.array(z.string().min(1)).optional(),
  /**
   * Restrict scan to a single node id. The in-preview search bar uses
   * this to limit the content scan to the one open node.
   */
  nodeId: z.string().min(1).optional(),
  /**
   * Which fields to scan. Defaults to all four. Omitting `content` keeps
   * the request entirely in the metadata tier (label/summary/keywords)
   * which the server can satisfy without reading any markdown body —
   * useful for "fast lookahead" suggestions.
   */
  fields: z.array(searchFieldSchema).optional(),
});
export type CanvasSearchRequest = z.infer<typeof canvasSearchRequestSchema>;

// ─── Response (NDJSON events) ──────────────────────────────────────────────

/**
 * One match. `snippet` is a ~120-char window around the first hit with
 * the match offset (relative to the snippet, not the original field)
 * so the client can render a highlighted excerpt without re-running
 * the regex. For the `label` field, snippet === field value.
 */
export interface CanvasSearchMatch {
  nodeId: string;
  nodeType: string;
  /** The node's display label at scan time (handy for result rows). */
  label: string | null;
  field: SearchField;
  snippet: string;
  /** Match start offset within `snippet` (not within the original field). */
  matchStart: number;
  matchLength: number;
}

/** NDJSON frame types emitted by the server. */
export type CanvasSearchEvent =
  | {
      type: 'match';
      /**
       * Tier this match was produced in. Lets the client visually
       * separate the fast metadata hits from the body content hits.
       */
      tier: 'meta' | 'content';
      match: CanvasSearchMatch;
    }
  | {
      type: 'progress';
      /**
       * Coarse scan progress for the long content tier. `phase` lets
       * the client switch from "Searching titles…" to "Searching
       * contents…" between tiers. `scanned` / `total` are node counts
       * for the content phase, suitable for a determinate progress bar.
       */
      phase: 'meta-done' | 'content';
      scanned?: number;
      total?: number;
    }
  | {
      type: 'done';
      /** Total matches emitted across both tiers. */
      total: number;
      /** True when the per-tier `limit` was hit and the scan stopped early. */
      truncated: boolean;
    }
  | {
      type: 'error';
      message: string;
    };
