/**
 * Canvas Events API
 *
 * Wire types for batch upload / read of `<canvasId>/.history/events.jsonl`.
 * Per docs/api-design.md the schemas are the single source of truth and
 * the TS types are derived via `z.infer`. The web bundle imports these
 * as `import type` only so zod stays out of the production browser code.
 */

import { z } from 'zod';

import { CANVAS_NODE_TYPES } from '../canvas/node.js';

// ─── NodeRef ───────────────────────────────────────────────────────────────

/**
 * NodeOrigin shape mirrors the discriminated union in
 * `packages/shared/src/types/canvas/node.ts`. Kept loose (only `type` is
 * required) so older clients that omit ancillary fields still validate.
 */
const nodeOriginSchema = z
  .object({
    type: z.enum([
      'ai-operate',
      'user-created',
      'user-uploaded',
      'user-pasted',
      'user-from-library',
      'user-from-chat',
      'user-excerpt',
      'annotation-recognized',
    ]),
    threadId: z.string().optional(),
    excerptFromNodeId: z.string().optional(),
  })
  .passthrough();

const nodeRefSchema = z.object({
  id: z.string().min(1),
  type: z.enum(CANVAS_NODE_TYPES),
  label: z.string().optional(),
  origin: nodeOriginSchema.optional(),
});

// ─── NodeEditDiff ─────────────────────────────────────────────────────────

const nodeEditDiffSchema = z.object({
  op: z.enum([
    'create',
    'clear',
    'append',
    'prepend',
    'insert',
    'trim',
    'trim_tail',
    'tweak',
    'rewrite',
  ]),
  beforeLen: z.number().int().nonnegative(),
  afterLen: z.number().int().nonnegative(),
  charsAdded: z.number().int().nonnegative(),
  charsRemoved: z.number().int().nonnegative(),
});

// ─── RecentAction ─────────────────────────────────────────────────────────

const edgePairSchema = z.object({
  source: nodeRefSchema,
  target: nodeRefSchema,
});

/**
 * Runtime schema mirroring the `RecentAction` discriminated union in
 * `packages/shared/src/types/agent/context.ts`. Keep these in sync
 * whenever a new action arm is added.
 */
export const recentActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('node_created'),
    nodes: z.array(nodeRefSchema),
  }),
  z.object({
    action: z.literal('nodes_deleted'),
    nodes: z.array(nodeRefSchema.extend({ snippet: z.string().optional() })),
  }),
  z.object({
    action: z.literal('node_edited'),
    node: nodeRefSchema,
    edit: nodeEditDiffSchema.optional(),
  }),
  z.object({
    action: z.literal('node_selected'),
    node: nodeRefSchema,
  }),
  z.object({
    action: z.literal('nodes_selected'),
    nodes: z.array(nodeRefSchema),
  }),
  z.object({
    action: z.literal('node_expanded'),
    node: nodeRefSchema,
  }),
  z.object({
    action: z.literal('node_connected'),
    source: nodeRefSchema,
    target: nodeRefSchema,
  }),
  z.object({
    action: z.literal('edges_disconnected'),
    edges: z.array(edgePairSchema),
  }),
  z.object({
    action: z.literal('node_framed'),
    node: nodeRefSchema,
    frame: nodeRefSchema,
  }),
  z.object({
    action: z.literal('node_unframed'),
    node: nodeRefSchema,
    frame: nodeRefSchema,
  }),
  z.object({
    action: z.literal('frame_unframed'),
    frame: nodeRefSchema,
    nodes: z.array(nodeRefSchema),
  }),
  z.object({
    action: z.literal('node_resized'),
    node: nodeRefSchema,
    width: z.number(),
    height: z.number(),
  }),
  z.object({
    action: z.literal('nodes_reordered'),
    nodes: z.array(nodeRefSchema),
  }),
  z.object({
    action: z.literal('nodes_moved'),
    nodes: z.array(nodeRefSchema),
  }),
  z.object({ action: z.literal('canvas_undone') }),
  z.object({ action: z.literal('canvas_redone') }),
]);

// ─── Wire envelopes ───────────────────────────────────────────────────────

/** One event as it appears in the upload batch (server may fill `ts`). */
export const canvasEventInputSchema = z.object({
  ts: z.number().int().positive().optional(),
  payload: recentActionSchema,
});

/** One event as it lives on disk / is returned on read. */
export const canvasEventRecordSchema = z.object({
  ts: z.number().int().positive(),
  payload: recentActionSchema,
});

/**
 * Body for `POST /api/canvas/:canvasId/events`.
 *
 * Capped at 200 events per request (anything larger should be split by
 * the client). The server additionally enforces a 64 KB body size cap
 * via Fastify's per-route `bodyLimit` to keep memory bounded.
 */
export const postCanvasEventsBodySchema = z.object({
  events: z.array(canvasEventInputSchema).min(1).max(200),
});
export type PostCanvasEventsRequest = z.infer<
  typeof postCanvasEventsBodySchema
>;

export interface PostCanvasEventsResponse {
  /** Number of events actually appended (echoes `events.length`). */
  appended: number;
}

/**
 * Querystring for `GET /api/canvas/:canvasId/events`.
 *
 * Numbers arrive as strings on the wire — coerce them. `limit` defaults
 * to 100 server-side when omitted; `since` filters to records with
 * `ts >= since` (Unix ms).
 */
export const getCanvasEventsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
  since: z.coerce.number().int().positive().optional(),
});
export type GetCanvasEventsQuery = z.infer<typeof getCanvasEventsQuerySchema>;

export interface GetCanvasEventsResponse {
  events: Array<z.infer<typeof canvasEventRecordSchema>>;
}
