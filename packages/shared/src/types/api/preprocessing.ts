// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Preprocessing Pipeline — Wire Types & Schemas
 *
 * Request/response shapes exchanged between web and server for the unified
 * node preprocessing endpoint. Internal pipeline machinery (capabilities,
 * profiles, full result, diagnostics) lives server-side in
 * `apps/server/src/modules/preprocessing/types.ts`.
 *
 * Per docs/architecture/api-design.md: schema is the single source of truth, types are
 * derived via `z.infer`.
 */

import { z } from 'zod';

import { executeOriginatorSchema } from './canvas.js';

import type { CanvasCommitEvent, MutationAck } from './canvas-sync.js';

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
 * its `data.content` flows through the same Enrich path used
 * by `note` / `text` to derive an auto-label from the user's prompt.
 */
export const preprocessableNodeTypeSchema = z.enum([
  'note',
  'text',
  'web',
  'pdf',
  'office',
  'image',
  'video',
  'frame',
  'question',
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
  /** Originating tab/session for optimistic echo filtering. */
  originator: executeOriginatorSchema.optional(),
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
  /**
   * Space cursor observed for a non-committing projection. Clients must not
   * apply legacy projection fields after their cursor has advanced beyond it.
   */
  observedVersion?: number;
  /** Opaque revision over the complete canonical node record. */
  recordRevision?: string;
  /** Full Phase 4 publication; preferred over ack when available. */
  commit?: CanvasCommitEvent;
  /** Phase 4 commit acknowledgement; optional for legacy servers. */
  ack?: MutationAck;
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
  /**
   * Extracted body content the client should adopt as `data.content`.
   *
   * Only emitted for node types whose in-canvas preview reads from
   * `data.content` directly (currently: `office`). Without this
   * field the freshly-extracted body lives only in the `.md` sidecar
   * on disk and the preview stays blank until the next canvas reload
   * re-hydrates it. PDF / web / note are deliberately excluded — their
   * previews render the source artifact / iframe / user-typed body
   * and never consult `data.content`, so shipping the (potentially
   * large) extracted text would be pure bloat.
   */
  content?: string;
  /** LLM-generated summary of the node content (from the Enrich stage). */
  summary?: string;
  /** LLM-generated keywords for the node content (from the Enrich stage). */
  keywords?: string[];
  /** Structured error description, if any. */
  error?: string;
}
