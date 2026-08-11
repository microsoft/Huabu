// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Canvas API Types
 * REST API request/response types for canvas operations.
 *
 * Per docs/architecture/api-design.md: schemas are the single source of truth, types
 * derived via `z.infer`.
 */

import { z } from 'zod';

import { agentBindingSchema } from './agent.js';

import type { CanvasCommitEvent, MutationAck } from './canvas-sync.js';

export interface GetCanvasResponse {
  canvasId: string;
  title: string | null;
  version: number;
  /** Opaque SHA-256 revision of the canonical slim title/nodes/edges view. */
  structureRevision?: string;
  state: unknown;
}

const canonicalCanvasIdSchema = z.string().regex(/^canvas-.+$/);
const canonicalNodeIdSchema = z.string().regex(/^node-.+$/);

const resolvedSourceNodeSchema = z
  .object({
    type: z.string().min(1),
    label: z.string().optional(),
    summary: z.string().optional(),
    preview: z.string().optional(),
    rev: z.string().optional(),
    threadId: z.string().min(1).optional(),
    status: z.enum(['idle', 'running', 'done', 'error']).optional(),
    viewed: z.boolean().optional(),
    agentMode: z.enum(['ask', 'operate']).optional(),
    agentBinding: agentBindingSchema.optional(),
    hasAuthoredContent: z.boolean().optional(),
  })
  .strict();

export const resolvedWorldReferenceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('canvasRef'),
      referenceNodeId: canonicalNodeIdSchema,
      targetCanvasId: canonicalCanvasIdSchema,
      status: z.enum(['ok', 'canvas-missing']),
      title: z.string().nullable().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('nodeRef'),
      referenceNodeId: canonicalNodeIdSchema,
      target: z
        .object({
          canvasId: canonicalCanvasIdSchema,
          nodeId: canonicalNodeIdSchema,
        })
        .strict(),
      status: z.enum(['ok', 'canvas-missing', 'node-missing']),
      source: resolvedSourceNodeSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('frameRef'),
      referenceNodeId: canonicalNodeIdSchema,
      target: z
        .object({
          canvasId: canonicalCanvasIdSchema,
          nodeId: canonicalNodeIdSchema,
        })
        .strict(),
      status: z.enum(['ok', 'canvas-missing', 'node-missing']),
      source: resolvedSourceNodeSchema.optional(),
    })
    .strict(),
]);
export type ResolvedWorldReference = z.infer<
  typeof resolvedWorldReferenceSchema
>;

export const getWorldReferencesResponseSchema = z
  .object({
    references: z.array(resolvedWorldReferenceSchema),
  })
  .strict();
export type GetWorldReferencesResponse = z.infer<
  typeof getWorldReferencesResponseSchema
>;

/**
 * Originator metadata describing who initiated a mutation. The server records
 * this in commit metadata so tabs can filter their own optimistic echo.
 */
export const executeOriginatorSchema = z.object({
  source: z.enum(['ui', 'agent', 'system']),
  /** Web tab/session identifier; opaque to the server. */
  tabId: z.string().optional(),
  /** Authenticated user id when known. */
  userId: z.string().optional(),
  /**
   * ACP chat thread that initiated this batch (set by the reachback
   * tool). Lets the broadcast attribute the change to the right
   * conversation's review card.
   */
  threadId: z.string().optional(),
});
export type ExecuteOriginator = z.infer<typeof executeOriginatorSchema>;

/** Body for `PUT /api/canvas/:canvasId`. */
export const putCanvasBodySchema = z.object({
  version: z.number().int().nonnegative(),
  state: z.unknown(),
  title: z.string().min(1).optional(),
  /**
   * Optional structural baseline used to distinguish a stale topology from a
   * harmless version advance caused by a node-only commit.
   */
  expectStructureRevision: z.string().min(1).optional(),
  /** No client commit/idempotency id: the server mints `ack.commitId`. */
  originator: executeOriginatorSchema.optional(),
});
export type PutCanvasRequest = z.infer<typeof putCanvasBodySchema>;

export interface PutCanvasResponse {
  canvasId: string;
  version: number;
  /** Full Phase 4 publication; preferred over ack when available. */
  commit?: CanvasCommitEvent;
  /** Phase 4 commit acknowledgement; optional for legacy servers. */
  ack?: MutationAck;
}

/** Optional metadata body for `DELETE /api/canvas/:canvasId/nodes/:nodeId`. */
export const deleteNodeBodySchema = z.object({
  /** Originating tab/session for optimistic echo filtering. */
  originator: executeOriginatorSchema.optional(),
});
export type DeleteNodeRequest = z.infer<typeof deleteNodeBodySchema>;

export interface DeleteNodeResponse {
  success: boolean;
  /** Full Phase 4 publication; preferred over ack when available. */
  commit?: CanvasCommitEvent;
  /** Phase 4 commit acknowledgement; optional for legacy servers. */
  ack?: MutationAck;
}

// ─── Per-node content endpoints ───────────────────────────────────────────

/**
 * Body for `PUT /api/canvas/:canvasId/nodes/:nodeId/content`.
 *
 * Carries the per-node fields that are persisted into the markdown sidecar
 * (`nodes/<safe(label)>.md`). Every field except `nodeType` is optional so
 * a callsite can write only the bits that actually changed; missing
 * fields are read from the existing `.md` and round-tripped untouched.
 *
 * See `docs/node-content-api-split.md`.
 */
export const putNodeContentBodySchema = z.object({
  /** Node type (`note` / `text` / `web` / `pdf` / `image` / `video` / `frame` / `question` / `sketch`). */
  nodeType: z.string().min(1),
  /** Markdown body. Only meaningful for text-bearing types (note/text/web/pdf). */
  content: z.string().optional(),
  /** Display label / filename stem. `null` clears any explicit label. */
  label: z.string().nullable().optional(),
  /**
   * Provenance of the label. `'user'` triggers strict-rename mode on the
   * server (409 on collision); `'agent'` / `'auto'` use lazy dedupe.
   */
  labelSource: z.enum(['user', 'auto', 'agent']).optional(),
  /**
   * Media source for source-backed nodes. Accepts a staged upload path
   * (`upload/<name>`), a bare artifact key (`artifact-…` / `gen-…`), or an
   * `https://…` URL; the server relocates / downloads it into the artifact
   * store and persists a bare key.
   */
  src: z.string().optional(),
  /** AI-derived one-line summary persisted to frontmatter. */
  summary: z.string().optional(),
  /** AI-derived keyword list persisted to frontmatter. */
  keywords: z.array(z.string()).optional(),
  /** Opaque pass-through frontmatter blob (e.g. AI provenance markers). */
  provenance: z.unknown().optional(),
  /**
   * Optimistic-concurrency baseline: the {@link nodeRevision} the client's
   * edit descends from (a deterministic djb2 over the node's authored
   * `content` / `src`). The server recomputes the on-disk node's revision
   * and rejects the write with `NODE_CONTENT_CONFLICT` when it differs, so
   * a concurrent edit (another tab / device / an agent, or a Google-Drive
   * synced newer copy) is surfaced as a conflict instead of silently
   * overwritten. The first sidecar write for an already-acknowledged topology
   * node carries the revision of empty content (`nodeRevisionOf({})`), so it
   * only succeeds while no file exists yet (guards create-races too). The
   * endpoint never creates topology, and `nodeType` must still match the
   * canonical topology type. Omit to skip the authored-content comparison
   * (kept optional so non-CAS callers still work).
   */
  expectRev: z.string().optional(),
  /** Originating tab/session for optimistic echo filtering. */
  originator: executeOriginatorSchema.optional(),
});
export type PutNodeContentRequest = z.infer<typeof putNodeContentBodySchema>;

/**
 * Response for `PUT /api/canvas/:canvasId/nodes/:nodeId/content`.
 *
 * `label` is the value actually persisted to the markdown frontmatter
 * (and the on-disk filename). For agent-sourced labels it may differ
 * from the request `label` because the server appends a ` (N)` suffix
 * to dedupe; the client must patch its in-memory `data.label` with this
 * value to stay aligned with the canonical `.md`.
 */
export interface PutNodeContentResponse {
  nodeId: string;
  label: string | null;
  /**
   * Canonical body returned only when the server refused an accidental
   * empty-body clobber. The client restores it if the optimistic empty value
   * is still current; a newer local edit always wins.
   */
  content?: string;
  contentPreserved?: boolean;
  /**
   * The {@link nodeRevision} of the content the server actually persisted.
   * The client stores this as the node's new optimistic-concurrency
   * baseline (co-delivered with the write it confirms, so content and its
   * baseline never update through separate channels). Authoritative: it
   * reflects any server-side normalization (e.g. a refused empty-body
   * clobber that kept the existing content).
   */
  rev: string;
  /** Opaque revision over the complete canonical node record. */
  recordRevision?: string;
  /** Full Phase 4 publication; preferred over ack when available. */
  commit?: CanvasCommitEvent;
  /** Phase 4 commit acknowledgement; optional for legacy servers. */
  ack?: MutationAck;
  /** True when the markdown file could not be read back after write. */
  contentMissing?: boolean;
  /** True when the referenced artifact file is missing on disk. */
  artifactMissing?: boolean;
}

/**
 * Response for `GET /api/canvas/:canvasId/nodes/:nodeId/content`.
 *
 * When `contentMissing` is true the markdown sidecar has not been written
 * yet (or was deleted out-of-band); sidecar-derived fields are unavailable.
 */
export interface GetNodeContentResponse {
  nodeId: string;
  type: string;
  label: string | null;
  labelSource?: 'user' | 'auto' | 'agent';
  src?: string;
  content: string;
  /**
   * The {@link nodeRevision} of the returned content. The client seeds this
   * as the node's optimistic-concurrency baseline on a single-node refresh
   * (same co-delivery discipline as {@link PutNodeContentResponse.rev}).
   */
  rev: string;
  /** Opaque revision over the complete canonical node record. */
  recordRevision?: string;
  summary?: string;
  keywords?: string[];
  contentMissing?: boolean;
  artifactMissing?: boolean;
  /** Mirror of {@link BaseNodeData.contentDuplicate} for single-node refresh. */
  contentDuplicate?: boolean;
  /** Mirror of {@link BaseNodeData.duplicateFiles} for single-node refresh. */
  duplicateFiles?: string[];
}

/** Response for DELETE /api/canvas/:canvasId. */
export interface DeleteCanvasResponse {
  success: boolean;
}

/**
 * Response for `POST /api/canvas/:canvasId/reveal-nodes` — opens the
 * canvas's `nodes/` folder in the host file manager (used to let the
 * user resolve duplicate markdown sidecars by hand).
 */
export interface RevealNodesFolderResponse {
  success: boolean;
}

/**
 * 409 Conflict body returned by `PUT /api/canvas/:canvasId` when the
 * client's version doesn't match the server's. Shaped like an
 * `ApiErrorBody` so the canonical client (`apiFetch`) surfaces it as a
 * normal `ApiError` and the caller can read `details.serverVersion`.
 */
export interface CanvasVersionMismatchError {
  message: string;
  code: 'CANVAS_VERSION_MISMATCH';
  details: { serverVersion: number };
}

// ─── Rename / conflict errors ─────────────────────────────────────────────

/**
 * Structured error codes returned from canvas mutation endpoints.
 *
 * Front-end uses the `code` discriminator — *not* the HTTP message —
 * to pick a UX (toast vs alert vs reload) and to localise the copy.
 * The server's `message` field stays an English fallback for
 * developer-facing logs and unknown-code situations.
 *
 * Codes fall into two buckets:
 * - **4xx conflicts**: caller submitted something that collides with
 *   existing state. Carried by {@link CanvasConflictResponse} with
 *   extra context (`conflictWith`, `nodeId`, `serverVersion`).
 * - **4xx/5xx operational failures**: request was well-formed but the
 *   server couldn't honour it (canvas missing, fs lock, etc.).
 *   Carried by the standard {@link ApiErrorBody}.
 */
export type CanvasErrorCode =
  | 'CANVAS_TITLE_CONFLICT'
  | 'NODE_LABEL_CONFLICT'
  | 'NODE_DUPLICATE_FILES'
  | 'NODE_CONTENT_CONFLICT'
  | 'CANVAS_VERSION_CONFLICT'
  | 'INVALID_REQUEST'
  | 'CANVAS_NOT_FOUND'
  | 'WORLD_PORTAL_MISSING'
  | 'NODE_FILE_DELETE_FAILED';

/**
 * Body shape for 4xx responses from canvas mutation endpoints.
 *
 * Conflicts return enough context for the client to revert the offending
 * field and tell the user what name they collided with.
 */
export interface CanvasConflictResponse {
  code: CanvasErrorCode;
  message: string;
  /** Existing label / title that the new value collided with. */
  conflictWith?: string;
  /** For node-level conflicts. */
  nodeId?: string;
  /** For version conflicts. */
  serverVersion?: number;
  /**
   * For `NODE_DUPLICATE_FILES`: every markdown sidecar filename on disk
   * that currently claims the node's id, so the client can list them in
   * the duplicate banner instead of forcing a reload to learn them.
   */
  duplicateFiles?: string[];
  /**
   * For `NODE_CONTENT_CONFLICT`: the on-disk node's current
   * {@link nodeRevision}. Lets the client re-seed its baseline after the
   * user chooses to refresh, and is handy for diagnostics.
   */
  currentRev?: string;
  /**
   * For `NODE_CONTENT_CONFLICT`: the baseline revision the rejected write
   * was based on (echo of the request's `expectRev`).
   */
  expectedRev?: string;
}

export interface UpdateCanvasStateParams {
  canvasId: string;
  version: number;
  nodes: unknown[]; // ReactFlow Node type
  edges: unknown[]; // ReactFlow Edge type
}

export interface UpdateCanvasStateResult {
  newVersion: number;
}

// ─── Canvas Export / Import ───────────────────────────────────────────────────

/**
 * Querystring for `GET /api/canvas/:canvasId/export`.
 *
 * `includeHistory` arrives as a string ("true" / "false") because all
 * querystring values are strings on the wire. Defaults to true when
 * omitted, mirroring the pre-schema behaviour.
 */
export const exportCanvasQuerySchema = z.object({
  includeHistory: z.enum(['true', 'false']).optional(),
});
export type ExportCanvasQuery = z.infer<typeof exportCanvasQuerySchema>;

/**
 * Response returned after a successful import.
 * The server allocates a fresh canvas id and restores the bundle in place.
 */
export interface ImportCanvasResponse {
  canvasId: string;
}

// ─── Canvas List / Create ─────────────────────────────────────────────────────

/** Summary of a single canvas returned by the list endpoint. */
export interface CanvasSummary {
  canvasId: string;
  title: string | null;
  nodeCount: number;
  createdAt: number;
  updatedAt: number;
}

/** Response for GET /api/canvas (list all canvases). */
export interface ListCanvasesResponse {
  canvases: CanvasSummary[];
}

/** Request body for POST /api/canvas (create a new canvas). */
export const createCanvasBodySchema = z.object({
  title: z.string().min(1).optional(),
});
export type CreateCanvasRequest = z.infer<typeof createCanvasBodySchema>;

/** Response for POST /api/canvas (create a new canvas). */
export interface CreateCanvasResponse {
  canvasId: string;
  title: string | null;
}

// ─── Headless Executor: POST /api/canvas/:canvasId/execute ────────────────
//
// The headless executor (M2) accepts a batch of canvas commands and
// runs them server-side against authoritative structural state.
// It returns the resulting structural deltas plus per-command outcomes
// so clients can apply the diff locally without re-executing the
// engine themselves.
//
// See `docs/proposals/headless-executor-plan.md` §M2 and the implementation at
// `apps/server/src/modules/canvas/canvas-executor.ts`.

/**
 * Body for `POST /api/canvas/:canvasId/execute`.
 *
 * `commands` is intentionally `z.array(z.unknown())` — the canvas
 * command union is large and is validated by the engine's per-handler
 * guards. The server still parses each command against the engine's
 * runtime narrowing before it touches state.
 */
export const postCanvasExecuteBodySchema = z.object({
  commands: z.array(z.unknown()),
  originator: executeOriginatorSchema,
  /** Optional client-supplied run id for tracing / multi-batch grouping. */
  runId: z.string().optional(),
});
export type PostCanvasExecuteRequest = z.infer<
  typeof postCanvasExecuteBodySchema
>;

/** Per-command outcome returned alongside the structural deltas. */
export interface CanvasExecuteCommandOutcome {
  /**
   * Bounded projection of the command the server executed. Node sidecar
   * fields are omitted; server-assigned ids and structural fields remain.
   */
  command: unknown;
  applied: boolean;
  /** Engine-supplied failure reason when `applied === false`. */
  reason?: string;
}

/**
 * Server-derived post-effect manifest forwarded to clients so the web
 * can run web-only verbs (delete tracking, AI-edit flag, deferred
 * frame fit, preprocessing dispatch) without re-running the shared
 * engine.
 *
 * Mirrors the subset of {@link PendingEffects} that has client-side
 * meaning.
 *
 * `mutatedNodes` remains while preprocessing dispatch runs on the web. Phase
 * 4 producers send the canonical slim topology projection here; node bodies
 * are carried only by the bounded `CanvasCommitEvent.nodeChanges` channel.
 */
export interface CanvasExecutePendingEffects {
  /** Slim final topology nodes that were created or edited. */
  mutatedNodes: unknown[];
  deletedNodeIds: string[];
  contentEditedNodeIds: string[];
  deferredFitFrameIds: string[];
}

/**
 * Response body for `POST /api/canvas/:canvasId/execute`.
 *
 * `fromVersion` is the canvas version observed at the start of the
 * batch; `toVersion` is the version after persistence. A no-op batch
 * (`deltas: []`) leaves the version unchanged so concurrent clients
 * don't get spurious 409s from idempotent calls.
 */
export interface PostCanvasExecuteResponse {
  canvasId: string;
  fromVersion: number;
  toVersion: number;
  /** Full Phase 4 publication; preferred over ack when available. */
  commit?: CanvasCommitEvent;
  /** Phase 4 commit acknowledgement; optional for legacy servers. */
  ack?: MutationAck;
  /** Deltas observed between prestate and poststate, in apply order. */
  deltas: unknown[];
  /** Per-command outcomes (one entry per submitted command). */
  results: CanvasExecuteCommandOutcome[];
  /**
   * Bounded command projections as the server executed them. Carries
   * server-assigned ids and structural annotations, but omits node sidecar
   * bodies and derived metadata.
   */
  commands: unknown[];
  /** Subset of engine-pending effects that clients should drain. */
  pendingEffects: CanvasExecutePendingEffects;
  /** Optional run id; echoed from the request when supplied. */
  runId?: string;
}
