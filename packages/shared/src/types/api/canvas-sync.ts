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
 * Two event kinds:
 *  - `snapshot` — sent once on connect. Carries the canvas's current
 *    `version` so a client that connected *after* a mutation can detect
 *    the gap (snapshot.version !== local version) and `loadCanvas` to
 *    catch up.
 *  - `update` — sent after every persisted `/execute` batch. Carries the
 *    structural `deltas` + `pendingEffects` the client replays via
 *    `applyDeltasFromAgent`, gated on `fromVersion === local version`.
 *
 * `deltas` / `pendingEffects.mutatedNodes` are modelled as `unknown` on
 * the wire — they mirror the same loosely-typed payload already used by
 * `PostCanvasExecuteResponse` (the engine `Delta` / `CanvasNode` shapes
 * live in the canvas-engine module, not the API layer). The web client
 * casts them back when handing off to `applyDeltasFromAgent`.
 */

import { z } from 'zod';

import type { CanvasChangeRecord } from '../../canvas-engine/change.js';

export const canvasSyncPendingEffectsSchema = z.object({
  /** Final post-execution snapshots of nodes that were created or edited. */
  mutatedNodes: z.array(z.unknown()),
  deletedNodeIds: z.array(z.string()),
  contentEditedNodeIds: z.array(z.string()),
  deferredFitFrameIds: z.array(z.string()),
});

export const canvasSyncEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('snapshot'),
    data: z.object({ version: z.number() }),
  }),
  z.object({
    type: z.literal('update'),
    data: z.object({
      fromVersion: z.number(),
      toVersion: z.number(),
      /** Structural deltas between prestate and poststate, in apply order. */
      deltas: z.array(z.unknown()),
      pendingEffects: canvasSyncPendingEffectsSchema,
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
    }),
  }),
]);

export type CanvasSyncEvent = z.infer<typeof canvasSyncEventSchema>;

/** Response for `GET /api/canvas/:canvasId/threads/:threadId/changes`. */
export interface GetThreadChangesResponse {
  changes: CanvasChangeRecord[];
}

/**
 * Response for `DELETE /api/canvas/:canvasId/threads/:threadId/changes/:changeId`
 * (accept / discard a single review record).
 */
export interface DeleteThreadChangeResponse {
  removed: boolean;
}
