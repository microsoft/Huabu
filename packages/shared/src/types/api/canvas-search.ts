// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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
 *  - `label`        — node.data.label (always present, tiny)
 *  - `summary`      — sidecar frontmatter `summary:` (one-line AI summary)
 *  - `keywords`     — sidecar frontmatter `keywords:` (string[])
 *  - `content`      — sidecar markdown body (the heavy one)
 *  - `conversation` — the chat thread a question node owns: every user
 *                     message + assistant reply across all turns,
 *                     read from `<threadId>.turns.jsonl`. Tool calls /
 *                     results are intentionally excluded. Heaviest tier
 *                     (one JSONL read per threaded node); only question
 *                     nodes carry a `threadId`, so free-floating threads
 *                     not anchored to a node are out of scope.
 */
export const searchFieldSchema = z.enum([
  'label',
  'summary',
  'keywords',
  'content',
  'conversation',
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
   * Cap on total matches in the response. Defaults to 1000 (server
   * `DEFAULT_LIMIT`). Hard upper bound 2000 so a malicious / runaway
   * query can't pin the server. Client paginates by re-issuing with a
   * narrower query, not by offset; once the cap is hit the server
   * emits `done { truncated: true }` and the UI shows a "narrow your
   * query" banner.
   */
  limit: z.number().int().positive().max(2000).optional(),
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
 * the regex. Snippets are always windowed/whitespace-collapsed —
 * including for short fields like `label` — so clients that need the
 * untruncated value should read it from a dedicated field instead
 * (e.g. the per-match `label` for node titles).
 */
export interface CanvasSearchMatch {
  /**
   * What kind of canvas entity this match belongs to.
   *
   * - `'node'` (default — also assumed when omitted by older
   *   payloads): the match is on a node field. `nodeId` is the
   *   node's id, `nodeType` is its React Flow type.
   * - `'edge'`: the match is on an edge label. `nodeId` is the
   *   edge's id (we keep the field name for back-compat with the
   *   original node-only schema; semantically it's "the matched
   *   entity's primary id"), `nodeType` is the literal `'edge'`,
   *   `field` is always `'label'`, and the source/target endpoints
   *   live in `sourceNodeId` / `targetNodeId` so the client can
   *   `fitView` on both ends of the edge.
   */
  kind?: 'node' | 'edge';
  nodeId: string;
  nodeType: string;
  /** The node's display label at scan time (handy for result rows). */
  label: string | null;
  field: SearchField;
  snippet: string;
  /** Match start offset within `snippet` (not within the original field). */
  matchStart: number;
  matchLength: number;
  /**
   * 0-based ordinal of this hit among all hits in the same
   * `(nodeId, field)`. Server-stamped at emission time so the client
   * can address the n-th occurrence inside a preview without having
   * to count `matchStart` values itself — which goes wrong as soon
   * as results truncate (global `limit` hits before this node's
   * earlier hits ship) or stream out of order (a later-stream-arriving
   * hit with a smaller `matchStart` would otherwise retroactively
   * change an already-clicked row's perceived ordinal).
   *
   * Always equals the count of matches the server has already emitted
   * for this `(nodeId, field)` pair — i.e. it survives truncation and
   * is monotonically increasing per (nodeId, field).
   */
  occurrenceIndex: number;
  /** Edge-only — source endpoint node id. Set iff `kind === 'edge'`. */
  sourceNodeId?: string;
  /** Edge-only — target endpoint node id. Set iff `kind === 'edge'`. */
  targetNodeId?: string;
}

/** NDJSON frame types emitted by the server. */
export type CanvasSearchEvent =
  | {
      type: 'match';
      /**
       * Tier this match was produced in. Lets the client visually
       * separate the fast metadata hits from the body content hits and
       * the chat-thread (`conversation`) hits.
       */
      tier: 'meta' | 'content' | 'conversation';
      match: CanvasSearchMatch;
    }
  | {
      type: 'progress';
      /**
       * Coarse scan progress for the long content tier. `phase` lets
       * the client switch from "Searching titles…" to "Searching
       * contents…" to "Searching conversations…" between tiers.
       * `scanned` / `total` are node counts for the content /
       * conversation phases, suitable for a determinate progress bar.
       */
      phase: 'meta-done' | 'content' | 'conversation';
      scanned?: number;
      total?: number;
    }
  | {
      type: 'done';
      /** Total matches emitted across both tiers. */
      total: number;
      /**
       * True when the request-level `limit` (a single global cap
       * across both the meta and content tiers — see the field docs
       * on {@link CanvasSearchRequest.limit}) was hit and the scan
       * stopped early.
       */
      truncated: boolean;
    }
  | {
      type: 'error';
      message: string;
    };
