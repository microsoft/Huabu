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

import { canvasContentPositionSchema } from './canvas-sync.js';

import type { videoCoverPatchSchema } from './preprocessing.js';
import type { SetSiblingOrderEvent } from '../../canvas-engine/siblingOrder.js';

export const nodePropertyValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.array(z.string()),
]);
export const nodePropertiesSchema = z.record(
  z.string(),
  nodePropertyValueSchema,
);
export const nodePropertiesPatchSchema = z.record(
  z.string(),
  nodePropertyValueSchema.nullable(),
);
export type NodePropertyValue = z.infer<typeof nodePropertyValueSchema>;
export type NodeProperties = z.infer<typeof nodePropertiesSchema>;
export type NodePropertiesPatch = z.infer<typeof nodePropertiesPatchSchema>;

export const recentCanvasConversationParamsSchema = z.object({
  canvasId: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid canvas ID'),
});
export type RecentCanvasConversationParams = z.infer<
  typeof recentCanvasConversationParamsSchema
>;

export const recentCanvasConversationResponseSchema = z.object({
  conversation: z
    .object({
      nodeId: z.string().min(1),
      threadId: z.string().min(1),
    })
    .nullable(),
});
export type RecentCanvasConversationResponse = z.infer<
  typeof recentCanvasConversationResponseSchema
>;

/** The caller's current Space permissions; every mutation remains server-authorized. */
export const canvasAccessSchema = z.object({
  /** May change node content and canvas structure. */
  write: z.boolean(),
  /** May rename, delete, or change ownership/parenthood of this Space. */
  manage: z.boolean(),
});
export type CanvasAccess = z.infer<typeof canvasAccessSchema>;

export const getCanvasResponseSchema = z.object({
  canvasId: z.string(),
  title: z.string().nullable(),
  version: z.number(),
  state: z.unknown(),
  /** Co-delivered with the loaded content; refreshed independently without discarding edits. */
  access: canvasAccessSchema,
  /** Canonical content revisions, including bodies omitted or normalized for rendering. */
  nodeContentRevisions: z.record(z.string(), z.string()).optional(),
  /**
   * The content position `state`'s node content is valid from: every
   * content save up to it is in this response, and the page asks for the
   * saves after it once its stream is open
   * (`GET /api/canvas/:canvasId/content/changes`).
   */
  contentPosition: canvasContentPositionSchema.optional(),
  /**
   * The read version of the Space, taken before `state` was read. A page
   * quotes it — with the version it has applied since — for the edits it
   * sends (`runs` of `POST /api/canvas/:canvasId/execute`).
   */
  basis: z.string().optional(),
});
export type GetCanvasResponse = z.infer<typeof getCanvasResponseSchema>;

export const deleteNodeParamsSchema =
  recentCanvasConversationParamsSchema.extend({
    nodeId: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid node ID'),
  });
export type DeleteNodeParams = z.infer<typeof deleteNodeParamsSchema>;
export const deleteNodeResponseSchema = z.object({ success: z.boolean() });
export type DeleteNodeResponse = z.infer<typeof deleteNodeResponseSchema>;

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
   * Custom properties as a keywise patch: `null` deletes one key and omitted
   * keys are preserved. Applied to the stored record as it is at the moment
   * of the write, without a revision: different keys never conflict and the
   * same key is last-writer-wins. `expectRev` does not cover it. A request
   * that carries only this patch (and `propertyDisplayKeys`) is never
   * refused as stale, and a request whose body is refused as stale still
   * has the patch applied (`propertiesApplied` on the conflict response).
   */
  properties: nodePropertiesPatchSchema.optional(),
  /** Display order of the custom properties, replaced as a whole. Unversioned like `properties`. */
  propertyDisplayKeys: z.array(z.string()).optional(),
  /**
   * Optimistic-concurrency baseline of the **body**: the {@link nodeRevision}
   * the client's edit descends from (a deterministic djb2 over the node's
   * `content` / `src`, and nothing else). The server recomputes the on-disk node's revision
   * and rejects the write with `NODE_CONTENT_CONFLICT` when it differs, so
   * a concurrent edit (another tab / device / an agent, or a Google-Drive
   * synced newer copy) is surfaced as a conflict instead of silently
   * overwritten. A brand-new node the client is creating carries the
   * revision of empty content (`nodeRevisionOf({})`), so the create only
   * succeeds while no file exists yet (guards create-races too). Omit to
   * skip the check entirely (kept optional so non-CAS callers still work).
   * Ignored on a request that carries only custom properties.
   */
  expectRev: z.string().optional(),
  /**
   * The saving page's id (its `originator.tabId` / presence page id). Echoed
   * as `originPageId` on the `invalidate` event so that page can tell its own
   * save from another page's. Not a credential.
   */
  pageId: z.string().min(1).max(64).optional(),
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
   * The {@link nodeRevision} of the content the server actually persisted.
   * The client stores this as the node's new optimistic-concurrency
   * baseline (co-delivered with the write it confirms, so content and its
   * baseline never update through separate channels). Authoritative: it
   * reflects any server-side normalization (e.g. a refused empty-body
   * clobber that kept the existing content).
   */
  rev: string;
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
export interface GetNodeContentResponse extends z.infer<
  typeof videoCoverPatchSchema
> {
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
  summary?: string;
  keywords?: string[];
  /** Opaque frontmatter blob (block-level AI-edit markers), when stored. */
  provenance?: unknown;
  properties?: NodeProperties;
  propertyDisplayKeys?: string[];
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
 *   extra context (`conflictWith`, `nodeId`).
 * - **4xx/5xx operational failures**: request was well-formed but the
 *   server couldn't honour it (canvas missing, fs lock, etc.).
 *   Carried by the standard {@link ApiErrorBody}.
 */
export type CanvasErrorCode =
  | 'CANVAS_TITLE_CONFLICT'
  | 'NODE_LABEL_CONFLICT'
  | 'NODE_DUPLICATE_FILES'
  | 'NODE_CONTENT_CONFLICT'
  | 'INVALID_REQUEST'
  | 'CANVAS_NOT_FOUND'
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
  /**
   * For `NODE_CONTENT_CONFLICT`: the request also carried a custom-property
   * patch (`properties` / `propertyDisplayKeys`) and that part **was
   * written**; only the body and the other fields were refused.
   */
  propertiesApplied?: boolean;
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
  /** Validate export eligibility without building or downloading the archive. */
  check: z.enum(['true', 'false']).optional(),
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
export const canvasSummarySchema = z.object({
  canvasId: z.string(),
  parentSpaceId: z.string().nullable().optional(),
  parentEntryNodeId: z.string().nullable().optional(),
  title: z.string().nullable(),
  nodeCount: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type CanvasSummary = z.infer<typeof canvasSummarySchema>;

/** Response for GET /api/canvas (list all canvases). */
export const listCanvasesResponseSchema = z.object({
  canvases: z.array(canvasSummarySchema),
});
export type ListCanvasesResponse = z.infer<typeof listCanvasesResponseSchema>;

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
 * Originator metadata describing who initiated the batch. The server
 * records this in the delta-log row so audit / replay can distinguish
 * agent-driven mutations from UI gestures.
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

/**
 * An earlier edit of the same page that a run was made on top of: a run of
 * this request (no `operationId`) or of an earlier request of the page.
 */
export const canvasExecuteRunRefSchema = z
  .object({
    /** The earlier request's id; omitted for a run of this request. */
    operationId: z.uuid().optional(),
    start: z.number().int().min(0),
    count: z.number().int().min(1),
  })
  .strict();
export type CanvasExecuteRunRef = z.infer<typeof canvasExecuteRunRefSchema>;

/** Most earlier edits one run may name. */
export const CANVAS_EXECUTE_RUN_AFTER_MAX = 64;

/**
 * One edit within an execute batch — a run of consecutive commands — and the
 * read version it was made on. Mirrors `ReadVersionRun` in the canvas engine.
 */
export const canvasExecuteRunSchema = z
  .object({
    /** Index of the edit's first command in `commands`. */
    start: z.number().int().min(0),
    /** How many consecutive commands belong to the edit. */
    count: z.number().int().min(1),
    /** The read version the page had when the edit was made. */
    basis: z.string().min(1).max(128),
    /**
     * Edits of this page, not yet confirmed when this one was made, whose
     * result it was made on top of. When one of them did not take effect
     * this run is refused too.
     */
    after: z
      .array(canvasExecuteRunRefSchema)
      .max(CANVAS_EXECUTE_RUN_AFTER_MAX)
      .optional(),
  })
  .strict();
export type CanvasExecuteRun = z.infer<typeof canvasExecuteRunSchema>;

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
  /**
   * Request id. Sending the same id with the same request again returns the
   * stored response instead of executing twice.
   */
  operationId: z.uuid().optional(),
  /** Read version the batch was built on; stale structural edits are rejected. */
  basis: z.string().min(1).max(128).optional(),
  /**
   * For `ui` batches: the edits the commands form, each with the read
   * version it was made on. An edit whose target was deleted or re-parented
   * by someone else after that version is refused as a whole
   * (`stale-target` / `stale-parent`). Commands outside every run are
   * checked against `basis`, when that is given.
   */
  runs: z.array(canvasExecuteRunSchema).optional(),
});
export type PostCanvasExecuteRequest = z.infer<
  typeof postCanvasExecuteBodySchema
>;

/** Per-command outcome returned alongside the structural deltas. */
export interface CanvasExecuteCommandOutcome {
  /** The (possibly annotated) command the server actually executed. */
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
 * `mutatedNodes` is included for now because preprocessing dispatch
 * still runs on the web in Phase A; once cross-tab broadcast (M3)
 * lands and the server drives preprocessing directly, this field can
 * be dropped from the wire and the web preprocessing trigger removed.
 */
export interface CanvasExecutePendingEffects {
  /** Final post-execution snapshots of nodes that were created or edited. */
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
  /** Deltas observed between prestate and poststate, in apply order. */
  deltas: unknown[];
  /** Per-command outcomes (one entry per submitted command). */
  results: CanvasExecuteCommandOutcome[];
  /**
   * Annotated commands as the server executed them. Carries any
   * server-assigned ids and `origin` / `labelSource` tags so the
   * client's revert UX can still derive `revertCommand` per-batch.
   */
  commands: unknown[];
  /** Subset of engine-pending effects that clients should drain. */
  pendingEffects: CanvasExecutePendingEffects;
  /**
   * Sibling paint order of every parent the batch changed, to replay after
   * `deltas`. Absent when no order changed; ignoring it keeps entity-only
   * replay.
   */
  orderEvents?: SetSiblingOrderEvent[];
  /**
   * Stored content revision of every node whose saved content (a sidecar
   * field) this batch created or changed, keyed by node id. The page that
   * applies `deltas` takes it as the node's save baseline. Absent when the
   * batch changed no node content.
   */
  nodeContentRevisions?: Record<string, string>;
  /**
   * Optional run id; echoed from the request when supplied. On a replayed
   * response it is the run id of the original request.
   */
  runId?: string;
  /** Echo of the request id, when one was supplied. */
  operationId?: string;
  /** Read version after this request; returned when `operationId`, `basis` or `runs` was supplied. */
  basis?: string;
  /** Present when this is the stored response of an earlier request. */
  replayed?: true;
}
