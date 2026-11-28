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

import {
  canvasContentPositionSchema,
  canvasPageIdSchema,
} from './canvas-sync.js';

import type { videoCoverPatchSchema } from './preprocessing.js';

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
   * sends (`edits[].basis` of `POST /api/canvas/:canvasId/execute`).
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
 * See `docs/architecture/canvas-realtime-sync.md` (Node content between
 * pages).
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
   *
   * A title a person or an agent gave is not versioned: `expectRev` does
   * not cover it, a request that carries nothing the revision covers is
   * never refused as stale, and a request whose body is refused as stale
   * still has the title applied (`titleApplied` on the conflict response).
   * Two writers of one title are last-writer-wins. An automatic title
   * (`'auto'`) is derived from a body and is checked with it.
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
   * `content` / `src`, and nothing else). It is checked for a request that
   * carries the body or something derived from one (`content`, `src`,
   * `summary`, `keywords`, `provenance`, an automatic title). The server recomputes the on-disk node's revision
   * and rejects the write with `NODE_CONTENT_CONFLICT` when it differs, so
   * a concurrent edit (another tab / device / an agent, or a Google-Drive
   * synced newer copy) is surfaced as a conflict instead of silently
   * overwritten. A brand-new node the client is creating carries the
   * revision of empty content (`nodeRevisionOf({})`), so the create only
   * succeeds while no file exists yet (guards create-races too). Omit to
   * skip the check entirely (kept optional so non-CAS callers still work).
   * Ignored on a request that carries only an authored title and/or custom
   * properties.
   */
  expectRev: z.string().optional(),
  /**
   * The person has left the editor of this `note` / `text` node: its body
   * is as they mean it, and the server derives the title from it. Saves
   * made while typing do not say so, because a title derived from each
   * intermediate body renamed the node's file again and again. Sent with
   * the save made on leaving the editor, which may carry nothing else when
   * the body was already saved.
   */
  editingEnded: z.boolean().optional(),
  /**
   * The saving page's id (its `originator.tabId` / presence page id). Echoed
   * as `originPageId` on the `invalidate` event so that page can tell its own
   * save from another page's — to streams of the saving principal only, so
   * another principal cannot make a page skip a save by quoting its id. Not
   * a credential.
   */
  pageId: canvasPageIdSchema.optional(),
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
  /**
   * For `NODE_CONTENT_CONFLICT`: the request also carried an authored title
   * (`label` / `labelSource` other than `auto`) and that part **was
   * written**; only the body and what is derived from it were refused.
   */
  titleApplied?: boolean;
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
// The headless executor accepts a batch of canvas commands and
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
  /**
   * The sending page's id. Together with the authenticated principal it
   * names the page whose own committed changes are not held against it.
   */
  tabId: canvasPageIdSchema.optional(),
  /**
   * Conversation that initiated this batch. Set by the Server only: by the
   * built-in agent's tool context, or by the Agent route from the
   * `X-Huabu-Host-Thread-Id` header of a request that arrived with an agent
   * credential. Lets the broadcast attribute the change to the right
   * conversation's review card.
   */
  threadId: z.string().optional(),
});
export type ExecuteOriginator = z.infer<typeof executeOriginatorSchema>;

/**
 * What an execute request to the page route may say about its sender: which
 * page it is, and nothing else. Who the request speaks for follows the
 * credential it arrived with (a person's session is `ui`, an agent or
 * machine credential is `agent`; `execute-admission.ts`), and which
 * conversation a batch belongs to is said only on the Agent route, by a
 * caller that arrived with an agent credential (`X-Huabu-Host-Thread-Id`).
 * The object is strict, so a request that states a `source` or a `threadId`
 * is refused.
 */
export const executeRequestOriginatorSchema = executeOriginatorSchema
  .omit({ source: true, threadId: true })
  .strict();
export type ExecuteRequestOriginator = z.infer<
  typeof executeRequestOriginatorSchema
>;

/**
 * An earlier edit of the same caller that an edit was made on top of: an
 * edit of this request (no `operationId`) or of an earlier request.
 */
export const canvasExecuteEditRefSchema = z
  .object({
    /** The earlier request's id; omitted for an edit of this request. */
    operationId: z.uuid().optional(),
    /** Position of the edit in that request's `edits`. */
    edit: z.number().int().min(0),
  })
  .strict();
export type CanvasExecuteEditRef = z.infer<typeof canvasExecuteEditRefSchema>;

/** Most earlier edits one edit may name. */
export const CANVAS_EXECUTE_EDIT_AFTER_MAX = 64;

/**
 * One edit of an execute request: the commands of one intent — one gesture
 * of a page, one step of an Agent — with the read version it was made on.
 * It takes effect as a whole or not at all.
 *
 * `commands` is intentionally `z.array(z.unknown())` — the canvas command
 * union is large and is validated by the route against the shape of each
 * command type before it touches state.
 */
export const canvasExecuteEditSchema = z
  .object({
    /**
     * The read version the edit was made on. An edit whose target was
     * deleted or re-parented by someone else after that version is refused
     * (`stale-target` / `stale-parent`). Omitted, the edit is not checked.
     */
    basis: z.string().min(1).max(128).optional(),
    /**
     * Edits of this caller, not yet confirmed when this one was made, whose
     * result it was made on top of. When one of them did not take effect
     * this edit does not run.
     */
    after: z
      .array(canvasExecuteEditRefSchema)
      .max(CANVAS_EXECUTE_EDIT_AFTER_MAX)
      .optional(),
    commands: z.array(z.unknown()).min(1),
  })
  .strict();
export type CanvasExecuteEdit = z.infer<typeof canvasExecuteEditSchema>;

/** An edit of this request can only come after an earlier edit of it. */
function refineEditOrder(
  edits: readonly { after?: readonly CanvasExecuteEditRef[] | undefined }[],
  context: z.RefinementCtx,
): void {
  edits.forEach((edit, index) => {
    (edit.after ?? []).forEach((ref, refIndex) => {
      if (ref.operationId === undefined && ref.edit >= index) {
        context.addIssue({
          code: 'custom',
          path: [index, 'after', refIndex, 'edit'],
          message: 'an edit can only come after an earlier edit of the request',
        });
      }
    });
  });
}

/** The `edits` of an execute request: at least one, in order. */
export const canvasExecuteEditsSchema = z
  .array(canvasExecuteEditSchema)
  .min(1)
  .superRefine(refineEditOrder);

/**
 * A plain command list as edits: one edit per command, each quoting `basis`.
 * This is what `{ commands, basis? }` means wherever it is still accepted
 * (the Agent route, the Server's own callers) — which is why a command that
 * fails there does not undo the others.
 */
export function editsPerCommand<Command>(
  commands: readonly Command[],
  basis?: string,
): { basis?: string; commands: Command[] }[] {
  return commands.map((command) => ({
    ...(basis !== undefined ? { basis } : {}),
    commands: [command],
  }));
}

/**
 * Body for `POST /api/canvas/:canvasId/execute`.
 *
 * The request is a list of edits. They run in order, each on the state the
 * ones before it left; an edit that does not take effect leaves no trace and
 * the others still apply.
 */
export const postCanvasExecuteBodySchema = z.object({
  /**
   * Request id. Sending the same id with the same request again returns the
   * stored outcome instead of executing twice.
   */
  operationId: z.uuid().optional(),
  /** Optional client-supplied run id for tracing / multi-batch grouping. */
  runId: z.string().optional(),
  originator: executeRequestOriginatorSchema.optional(),
  edits: canvasExecuteEditsSchema,
});
export type PostCanvasExecuteRequest = z.infer<
  typeof postCanvasExecuteBodySchema
>;

/** A node a command created or re-sized, as the server left it. */
export interface CanvasExecuteResultNode {
  nodeId: string;
  label?: string;
  width: number;
  height: number;
  src?: string;
}

/** An edge a command created, with the id the server gave it. */
export interface CanvasExecuteResultEdge {
  edgeId: string;
  source: string;
  target: string;
}

/** Outcome of one command of an edit. */
export interface CanvasExecuteCommandOutcome {
  applied: boolean;
  /** Engine-supplied failure reason when `applied === false`. */
  reason?: string;
  /**
   * Nodes the command created, with their server-assigned ids, and nodes
   * whose image it changed. The command itself is not echoed.
   */
  nodes?: CanvasExecuteResultNode[];
  /** Edges the command created, with their server-assigned ids. */
  edges?: CanvasExecuteResultEdge[];
}

/** Outcome of one edit of the request, at the same position. */
export interface CanvasExecuteEditOutcome {
  /**
   * The edit took effect: none of its commands failed (a `no-op` is not a
   * failure). When false, nothing of the edit was applied.
   */
  applied: boolean;
  /** Why the edit did not take effect. */
  reason?: string;
  /**
   * Position, within the edit, of the command that failed. Absent when the
   * edit was refused before its first command ran.
   */
  failedAt?: number;
  /** One outcome per command of the edit, in order. */
  results: CanvasExecuteCommandOutcome[];
}

/**
 * Server-derived post-effect manifest forwarded to clients so the web
 * can run web-only verbs (delete tracking, AI-edit flag, deferred
 * frame fit, preprocessing dispatch) without re-running the shared
 * engine.
 *
 * Ids only. A page that applies the batch has the nodes: it reads a mutated
 * node from its own state after the deltas are applied.
 */
export interface CanvasExecutePendingEffects {
  /** Ids of the nodes the batch created or whose `data` it changed. */
  mutatedNodeIds: string[];
  deletedNodeIds: string[];
  contentEditedNodeIds: string[];
  deferredFitFrameIds: string[];
}

/**
 * Response body for `POST /api/canvas/:canvasId/execute`.
 *
 * `fromVersion` is the canvas version observed at the start of the
 * batch; `toVersion` is the version after persistence. A request that
 * changed nothing leaves the version unchanged.
 *
 * A **replayed** response (`replayed: true`) answers a request id that was
 * already executed. It is rebuilt from the stored outcome and carries no
 * `deltas`: a page that has not applied `toVersion` yet receives them with
 * the `update` event, or loads the Space.
 */
export interface PostCanvasExecuteResponse {
  canvasId: string;
  fromVersion: number;
  toVersion: number;
  /**
   * What the request changed, in apply order: per node only the fields that
   * changed. Absent on a replayed response.
   */
  deltas?: unknown[];
  /** One outcome per edit of the request, in order. */
  edits: CanvasExecuteEditOutcome[];
  /** Subset of engine-pending effects that clients should drain. */
  pendingEffects: CanvasExecutePendingEffects;
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
  /** Read version after this request; returned when `operationId` or an edit's `basis` was supplied. */
  basis?: string;
  /** Present when this is the stored outcome of an earlier request. */
  replayed?: true;
  /**
   * Only on a replayed response whose outcome was too large to store whole:
   * order events and the per-command node and edge lists are missing. The
   * per-edit results and versions are always there.
   */
  incomplete?: true;
}
