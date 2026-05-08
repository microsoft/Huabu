/**
 * Preprocessing Pipeline — Wire Types & Schemas
 *
 * Request/response shapes exchanged between web and server for the unified
 * node preprocessing endpoint. Internal pipeline machinery (capabilities,
 * profiles, full result, diagnostics) lives server-side in
 * `apps/server/src/modules/preprocessing/types.ts`.
 *
 * Per docs/api-design.md: schema is the single source of truth, types are
 * derived via `z.infer`.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

/** Why preprocessing is running. */
export const triggerReasonSchema = z.enum([
  'node_inserted',
  'node_updated',
  'flush',
  'manual',
  'repair',
]);
export type TriggerReason = z.infer<typeof triggerReasonSchema>;

// ---------------------------------------------------------------------------
// Node type subset
// ---------------------------------------------------------------------------

/**
 * Subset of `CanvasNodeType` that the preprocess endpoint actually handles.
 * Excludes 'annotation' and 'question' which never carry preprocessable
 * payloads. Kept as its own enum so wire validation is tight and the
 * server doesn't have to defensively reject those types at runtime.
 */
export const preprocessableNodeTypeSchema = z.enum([
  'note',
  'text',
  'web',
  'pdf',
  'image',
  'video',
  'frame',
]);
export type PreprocessableNodeType = z.infer<
  typeof preprocessableNodeTypeSchema
>;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options that control how preprocessing runs. */
export const preprocessOptionsSchema = z.object({
  /** Allow LLM calls in the Enrich stage. Default: true. */
  allowLLM: z.boolean().optional(),
  /** Allow writing to the per-canvas content store. Default: true. */
  allowPersistence: z.boolean().optional(),
  /** Force reprocessing even if fingerprint matches. Default: false. */
  force: z.boolean().optional(),
  /** Execution mode. Default: 'background'. */
  mode: z.enum(['interactive', 'background', 'manual']).optional(),
});
export type PreprocessOptions = z.infer<typeof preprocessOptionsSchema>;

// ---------------------------------------------------------------------------
// Wire body (POST /:canvasId/nodes/:nodeId/preprocess)
// ---------------------------------------------------------------------------

/**
 * Body sent by the client. `canvasId` and `nodeId` are NOT part of it —
 * they come from the URL params and are merged into the internal
 * `PreprocessNodeRequest` server-side.
 */
export const preprocessNodeBodySchema = z.object({
  nodeType: preprocessableNodeTypeSchema,
  trigger: triggerReasonSchema.optional(),
  /** Current node data snapshot. */
  snapshot: z.record(z.string(), z.unknown()),
  /** Previous node data snapshot (for dirty-field detection on updates). */
  previousSnapshot: z.record(z.string(), z.unknown()).optional(),
  options: preprocessOptionsSchema.optional(),
});
export type PreprocessNodeBody = z.infer<typeof preprocessNodeBodySchema>;

// ---------------------------------------------------------------------------
// Internal request (assembled by the route handler from body + URL params)
// ---------------------------------------------------------------------------

/**
 * Full request consumed by the dispatcher / pipeline. Augments the wire
 * body with URL-derived ids and a non-optional `trigger` (the route
 * handler defaults missing triggers to `'node_updated'`).
 */
export interface PreprocessNodeRequest extends Omit<
  PreprocessNodeBody,
  'trigger'
> {
  canvasId: string;
  nodeId: string;
  trigger: TriggerReason;
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/**
 * Simplified response returned by the unified preprocess endpoint.
 */
export interface PreprocessNodeResponse {
  nodeId: string;
  success: boolean;
  /** LLM-suggested label from the Enrich stage (for image/frame, or title-derived for ingest types). */
  suggestedLabel?: string;
  /** Structured error description, if any. */
  error?: string;
}
