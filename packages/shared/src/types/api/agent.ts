/**
 * Agent API wire schemas.
 *
 * Validation contracts for the unified `/api/agent` endpoint and its
 * sibling routes (chat history, context tokens, intent recognition,
 * annotation, intent episode logging). Per docs/api-design.md: schemas
 * are the single source of truth, types derived via `z.infer`.
 *
 * Complex nested shapes that already have rich TypeScript interfaces
 * (e.g. `AgentChatContext`, `IntentContext`, `AnnotationClusterContext`,
 * `IntentEpisode`) are accepted via `z.custom<T>()` — top-level
 * structure is validated to reject malformed wrappers, but the inner
 * objects are trusted to conform to their existing types because they
 * are produced by the same client codebase that compiles against those
 * interfaces.
 */

import { z } from 'zod';

import type {
  AgentChatContext,
  AnnotationClusterContext,
  IntentContext,
  IntentEpisode,
} from '../agent/index.js';

/** A single attachment carried with a chat message. */
export const chatAttachmentSchema = z.object({
  type: z.enum(['image', 'pdf', 'text', 'file', 'web']),
  source: z.enum(['upload', 'excerpt', 'selection']),
  originNodeId: z.string().optional(),
  url: z.string().optional(),
  content: z.string().optional(),
  label: z.string().optional(),
  filename: z.string().optional(),
});

/** A single intent candidate produced by the recognizer. */
export const intentCandidateSchema = z.object({
  label: z.string().min(1),
  description: z.string().optional(),
});

/** Body for `POST /api/agent`. */
export const agentRequestSchema = z.object({
  content: z.string().min(1, 'Message content is required'),
  threadId: z.string().min(1).optional(),
  mode: z.enum(['ask', 'operate']).optional(),
  canvasContext: z.custom<AgentChatContext>().optional(),
  canvasId: z.string().min(1).optional(),
  attachments: z.array(chatAttachmentSchema).optional(),
  selectedNodeIds: z.array(z.string().min(1)).optional(),
  intentData: z
    .object({
      candidates: z.array(intentCandidateSchema),
      selectedIntent: z.string().min(1),
    })
    .optional(),
  /**
   * Anchor a node-neighbourhood preamble to this node id. When set,
   * the server resolves the node's surrounding-canvas context (see
   * `getNodeNeighbourhood` / `renderNodeNeighbourhoodMarkdown`) and
   * pushes a `[SYSTEM Context]` preamble — rendered from the Ask
   * agent's `nodeNeighbourhoodPreamble` template — before the actual
   * user message. Sent today by `useQuestionRunner` so the prompt
   * wording and the (potentially large) spatial graph stay off the
   * wire and out of the frontend bundle. Anchor-type agnostic; can
   * back any future "describe what's around X" flow.
   */
  anchorNodeId: z.string().min(1).optional(),
});
export type AgentRequest = z.infer<typeof agentRequestSchema>;

/** Querystring for `GET /api/agent/history` and `/api/agent/context-tokens`. */
export const agentCanvasIdQuerySchema = z.object({
  canvasId: z.string().min(1).optional(),
});
export type AgentCanvasIdQuery = z.infer<typeof agentCanvasIdQuerySchema>;

/** Body for `POST /api/intent/recognize` and `/recognize-stream`. */
export const intentRequestSchema = z.object({
  canvasContext: z.custom<IntentContext>(
    (v) => v !== null && typeof v === 'object',
    'canvasContext is required',
  ),
});
export type IntentRequest = z.infer<typeof intentRequestSchema>;

/** Body for `POST /api/intent/recognize-annotation`. */
export const annotationIntentRequestSchema = z.object({
  screenshot: z.string().min(1, 'screenshot is required'),
  clusterContext: z.custom<AnnotationClusterContext>(
    (v) => v !== null && typeof v === 'object',
    'clusterContext is required',
  ),
  canvasId: z.string().min(1).optional(),
});
export type AnnotationIntentRequest = z.infer<
  typeof annotationIntentRequestSchema
>;

/** Body for `POST /api/intent/episode`. */
export const intentEpisodeRequestSchema = z.object({
  episode: z.custom<IntentEpisode>(
    (v) =>
      v !== null &&
      typeof v === 'object' &&
      typeof (v as { id?: unknown }).id === 'string' &&
      (v as { id: string }).id.length > 0,
    'episode is required',
  ),
  canvasId: z.string().min(1).optional(),
});
export type IntentEpisodeRequest = z.infer<typeof intentEpisodeRequestSchema>;
