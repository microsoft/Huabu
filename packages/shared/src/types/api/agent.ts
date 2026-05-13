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
import type { CanvasNodeType } from '../canvas/node.js';

// ─── Wire-only node payloads ──────────────────────────────────────────────
//
// Wire shapes posted from the web client to `/api/agent` and
// `/api/intent/*`. Deliberately thin: only **raw canvas state**
// (id / type / label / content / src / parentId / position / size)
// crosses the wire — no server-side enrichment fields like
// `filename` (storage convention), `preview` (prompt formatting), or
// `parentFrame.label` (server-side lookup). The server enriches into
// `AgentNodeRef` / `AgentNodePreview` / `AgentNodeOutline` as needed
// before any prompt rendering.
//
// Keeping the wire payload thin means changing the LLM-facing prompt
// shape (preview length, filename rule, opt-in fields) does not
// require a frontend deploy.

/** Bare node identity payload — every wire ref starts here. */
export interface WireNodeRef {
  id: string;
  type: CanvasNodeType;
  label?: string;
}

/**
 * Selection wire shape posted from the web client to `/api/agent` and
 * `/api/intent/*`.
 *
 * Two things make this distinct from {@link WireNodeRef}:
 *
 *  1. **Recursive `children`** — frame nodes carry their direct
 *     children so the server can flatten the selection without a
 *     follow-up canvas read.
 *  2. **`src` for image nodes** — the server uses it to build
 *     vision attachments before the LLM ever sees the selection.
 *
 * The server normalises this into `AgentNodeRef[]` server-side
 * before any prompt rendering. Never sent to the LLM directly.
 */
export interface WireSelectionNode extends WireNodeRef {
  /** Source URL — only present for `type === 'image'`. */
  src?: string;
  /** Direct frame children; undefined for non-frame nodes. */
  children?: WireSelectionNode[];
}

/**
 * Wire shape for one node inside `IntentContext.nodes` (the full
 * canvas snapshot sent to the intent recogniser). Carries the raw
 * canvas-state fields the server needs to enrich into an
 * `AgentNodeOutline`:
 *
 *  - `content` / `src`  — fed into the preview ladder server-side
 *  - `parentId`         — server resolves into `parentFrame.label`
 *  - `position` / `size` — already resolved to absolute coords by web
 *
 * Deliberately **does not** carry `filename`, `preview`, or
 * `parentFrame.label` — those are server-side decisions.
 */
export interface WireCanvasNode extends WireNodeRef {
  /** Inline node body (markdown / plain text), when present. */
  content?: string;
  /** Source URL — meaningful for image / pdf / web / video nodes. */
  src?: string;
  /** Parent frame id (web has already done absolute-position resolution). */
  parentId?: string;
  /** Absolute position on canvas (top-left corner). */
  position: { x: number; y: number };
  /** Effective dimensions (measured > styled > 0 fallback). */
  size: { width: number; height: number };
}

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
