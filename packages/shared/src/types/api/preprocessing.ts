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
 * Node types that participate in the preprocessing pipeline.
 *
 * `sketch` is excluded — it never carries a preprocessable payload.
 * `question` IS included: although it never persists ingest text,
 * its `data.input.content` flows through the same Enrich path used
 * by `note` / `text` to derive an auto-label from the user's prompt.
 */
export const preprocessableNodeTypeSchema = z.enum([
  'note',
  'text',
  'web',
  'pdf',
  'image',
  'video',
  'frame',
  'question',
]);
export type PreprocessableNodeType = z.infer<
  typeof preprocessableNodeTypeSchema
>;

/**
 * Plain JS mirror of {@link preprocessableNodeTypeSchema}'s enum.
 *
 * Web bundle gate — lets the client skip the preprocess POST entirely
 * for node types the server would reject at zod validation (notably
 * `sketch`). Imported via `import type` keeps web zod-free; this Set
 * provides the runtime check without dragging zod in.
 *
 * Keep in lock-step with the enum above.
 */
export const PREPROCESSABLE_NODE_TYPES: ReadonlySet<string> = new Set([
  'note',
  'text',
  'web',
  'pdf',
  'image',
  'video',
  'frame',
  'question',
]);

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
  /**
   * Server-canonical `src` after the Persist stage — present when the
   * pipeline normalized the input URL (web → canonical URI; pdf →
   * canvas-scoped artifact URL) into a value that differs from the
   * snapshot `src` the client sent. The client should patch `data.src`
   * to this value so the in-memory canvas state matches what is now
   * persisted in the markdown sidecar; without this round-trip the
   * client would silently disagree with the server until the next
   * canvas reload re-hydrates the field.
   */
  src?: string;
  /** LLM-generated summary of the node content (from the Enrich stage). */
  summary?: string;
  /** LLM-generated keywords for the node content (from the Enrich stage). */
  keywords?: string[];
  /** Structured error description, if any. */
  error?: string;
}
