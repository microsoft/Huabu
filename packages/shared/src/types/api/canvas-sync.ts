// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Canvas real-time sync wire types.
 *
 * Server-Sent Events pushed on `GET /api/canvas/:canvasId/sync/stream`
 * so live frontends learn about out-of-band canvas mutations (e.g. an
 * ACP agent writing through the reachback `/execute` route) without
 * polling or a manual reload.
 *
 * Event kinds:
 *  - `invalidate` — ordinary saves/deletes invalidate bounded read models
 *    without replacing editable Canvas state. With `nodeIds` it also tells
 *    the other pages to fetch those nodes' saved content.
 *  - `snapshot` — sent once on connect. Carries the canvas's current
 *    `version` so a client that connected *after* a mutation can detect
 *    the gap (snapshot.version !== local version) and `loadCanvas` to
 *    catch up. Node content saved before the connection is not in it: a
 *    content save does not change `version`. The page asks for that
 *    separately, see {@link canvasContentChangesQuerySchema}.
 *  - `update` — sent after every persisted `/execute` batch. Carries the
 *    structural `deltas` + `pendingEffects` the client replays via
 *    `applyServerDeltas`, gated on `fromVersion === local version`.
 *    A Space rename also publishes one, with no deltas and the new `title`.
 *
 * `deltas` are modelled as `unknown` on the wire — they mirror the same
 * loosely-typed payload already used by `PostCanvasExecuteResponse` (the
 * engine `Delta` shape lives in the canvas-engine module, not the API
 * layer). The web client casts them back when handing off to
 * `applyServerDeltas`. A node row names only the fields that changed; a
 * deletion names the node's id.
 */

import { z } from 'zod';

import { CANVAS_PRESENCE_LIMITS } from './canvas-presence-limits.js';
import { isSetSiblingOrderEvent } from '../../canvas-engine/siblingOrder.js';

import type { CanvasChangeRecord } from '../../canvas-engine/change.js';
import type { SetSiblingOrderEvent } from '../../canvas-engine/siblingOrder.js';

/**
 * The id a browser page gives itself (one per loaded document). The one shape
 * for every place a page names itself: `originator.tabId` of an execute
 * request, `pageId` of a node-content save and of a presence report, and the
 * `pageId` of the Canvas Sync stream. It is chosen by the page, so it
 * identifies a page only together with the authenticated principal of the
 * request that carries it; on its own it is routing information, never a
 * credential.
 */
export const canvasPageIdSchema = z
  .string()
  .min(1)
  .max(CANVAS_PRESENCE_LIMITS.pageIdMaxLength)
  .regex(/^[a-zA-Z0-9_-]+$/, 'Invalid page ID');

export const canvasSyncPendingEffectsSchema = z.object({
  /**
   * Ids of the nodes the batch created or whose `data` it changed. The
   * receiving page reads them from its own state once `deltas` are applied.
   */
  mutatedNodeIds: z.array(z.string()),
  deletedNodeIds: z.array(z.string()),
  contentEditedNodeIds: z.array(z.string()),
  deferredFitFrameIds: z.array(z.string()),
});

export const canvasSyncEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('invalidate'),
    /** Read-model notification, not an instruction to replace editable Canvas state. */
    data: z.object({
      nodeIds: z.array(z.string()).optional(),
      /**
       * Page that made the node-content save behind this event, when it
       * named itself. That page already has what it wrote and does not
       * fetch it again; every other page does.
       */
      originPageId: canvasPageIdSchema.optional(),
      /**
       * A conversation whose pending review records changed without a canvas
       * write, as when one was kept, or after one was reverted. A page reads
       * that conversation's records again.
       */
      reviewThreadId: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal('snapshot'),
    data: z.object({
      version: z.number(),
    }),
  }),
  z.object({
    type: z.literal('update'),
    data: z.object({
      fromVersion: z.number(),
      toVersion: z.number(),
      /** Lifecycle projections do not create editable-operation undo entries. */
      agentNodeProjection: z.boolean().optional(),
      /** Structural deltas between prestate and poststate, in apply order. */
      deltas: z.array(z.unknown()),
      pendingEffects: canvasSyncPendingEffectsSchema,
      /**
       * Sibling paint order of every parent the batch changed, replayed
       * after `deltas`. Absent when no order changed.
       */
      orderEvents: z
        .array(z.custom<SetSiblingOrderEvent>(isSetSiblingOrderEvent))
        .optional(),
      /**
       * Stored content revision of every node whose saved content (a
       * sidecar field) this batch created or changed, keyed by node id — the
       * same value a load returns in `nodeContentRevisions`. A page takes it
       * as the node's save baseline instead of hashing the node in `deltas`,
       * which is not always what is stored. Absent when the batch changed no
       * node content.
       */
      nodeContentRevisions: z.record(z.string(), z.string()).optional(),
      /**
       * ACP chat thread that initiated this batch, when known. Lets the
       * client attach `changes` to the right conversation's review card.
       */
      threadId: z.string().optional(),
      /**
       * Per-change review records (`CanvasChangeRecord[]`), present only
       * for thread-attributed (ACP) batches. Carried as `unknown` on the
       * wire — the canvas-engine `CanvasChangeRecord` type lives outside
       * the API layer; the client casts.
       */
      changes: z.array(z.unknown()).optional(),
      /**
       * Request id the writer supplied with this batch, when it supplied
       * one. Lets a client recognise the echo of its own write.
       */
      operationId: z.string().optional(),
      /**
       * Who wrote the batch (`originator.source`). A page uses it to tell
       * another person's edit from an agent's; absent on batches that have
       * no originator (delta replays).
       */
      source: z.enum(['ui', 'agent', 'system']).optional(),
      /**
       * The Space's title after this version, present only on the update a
       * rename publishes (which carries no deltas). Lets open pages show the
       * new title without loading the Space again.
       */
      title: z.string().nullable().optional(),
    }),
  }),
]);

export type CanvasSyncEvent = z.infer<typeof canvasSyncEventSchema>;

/**
 * A point in a Space's sequence of node-content saves.
 *
 * `GET /api/canvas/:canvasId` returns the position its node content is
 * valid from (`contentPosition`): everything saved up to it is in that
 * response. `epoch` names the sequence and `seq` orders saves within it;
 * a page hands both back unchanged and never interprets them.
 */
export const canvasContentPositionSchema = z.object({
  epoch: z.string().min(1).max(128),
  seq: z.number().int().min(0),
});
export type CanvasContentPosition = z.infer<typeof canvasContentPositionSchema>;

/**
 * Query of `GET /api/canvas/:canvasId/content/changes`: the position the
 * page's content is valid from.
 */
export const canvasContentChangesQuerySchema = z.object({
  epoch: z.string().min(1).max(128),
  seq: z.coerce.number().int().min(0),
});
export type CanvasContentChangesQuery = z.infer<
  typeof canvasContentChangesQuerySchema
>;

/**
 * Response of `GET /api/canvas/:canvasId/content/changes`.
 *
 * `changedNodeIds` names every node whose content was saved after the
 * position asked from; it may also name a node saved at that position, so
 * fetching a named node must be harmless to repeat. `reset` is set instead
 * when the server cannot compare the position with its sequence: the page
 * then knows nothing and fetches every node that has saved content.
 * `position` is where the sequence stood for this answer; the page asks from
 * it next time.
 */
export interface CanvasContentChangesResponse {
  position: CanvasContentPosition;
  changedNodeIds?: string[];
  reset?: boolean;
}

/** Response for `GET /api/canvas/:canvasId/threads/:threadId/changes`. */
export interface GetThreadChangesResponse {
  changes: CanvasChangeRecord[];
}

/** Body of `POST /api/canvas/:canvasId/changes/query`. */
export const querySpaceChangesBodySchema = z.object({
  /** The conversations to read; a Space's page names those it shows. */
  threadIds: z.array(z.string().min(1).max(256)).max(500),
});

/**
 * Response for `POST /api/canvas/:canvasId/changes/query`: the pending
 * review records of each named thread that has any.
 */
export interface QuerySpaceChangesResponse {
  threads: Record<string, CanvasChangeRecord[]>;
}

/**
 * Response for `DELETE /api/canvas/:canvasId/threads/:threadId/changes/:changeId`
 * (accept / discard a single review record).
 */
export interface DeleteThreadChangeResponse {
  removed: boolean;
}
