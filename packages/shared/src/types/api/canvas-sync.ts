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
 *  - `update` — sent after a persisted mutation. Legacy producers carry the
 *    structural `deltas` + `pendingEffects` the client replays via
 *    `applyDeltasFromAgent`; Phase 4 producers additionally attach the
 *    canonical `commit` envelope used for every mutation path.
 *
 * `deltas` / `pendingEffects.mutatedNodes` are modelled as `unknown` on the
 * wire because the engine shapes live outside the API layer. Phase 4
 * producers project both to slim topology; sidecar bodies use the bounded
 * `commit.nodeChanges` channel instead.
 */

import { z } from 'zod';

import { executeOriginatorSchema } from './canvas.js';

import type { CanvasChangeRecord } from '../../canvas-engine/change.js';

/**
 * Maximum UTF-8 JSON size of an inline node UI projection in a commit event.
 * Larger records are announced as `invalidate` so extracted documents and
 * other derived content cannot accidentally turn the sync stream into a bulk
 * transfer channel.
 */
export const CANVAS_COMMIT_INLINE_NODE_MAX_BYTES = 64 * 1024;

/**
 * UI-facing projection of one canonical node record.
 *
 * This is deliberately narrower than the persistence record: storage-only
 * frontmatter never crosses the realtime boundary. `rev` is the existing
 * authored-content CAS token; the enclosing {@link NodeChange} carries the
 * separate whole-record `recordRevision`.
 */
export const nodeUiProjectionSchema = z
  .object({
    type: z.string().min(1),
    label: z.string().nullable(),
    content: z.string(),
    rev: z.string().min(1),
    labelSource: z.enum(['user', 'auto', 'agent']).optional(),
    src: z.string().optional(),
    summary: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    provenance: z.unknown().optional(),
    contentMissing: z.boolean().optional(),
    artifactMissing: z.boolean().optional(),
    contentDuplicate: z.boolean().optional(),
    duplicateFiles: z.array(z.string()).optional(),
  })
  .strict();
export type NodeUiProjection = z.infer<typeof nodeUiProjectionSchema>;

/** Return the byte count JSON.stringify would put on a UTF-8 wire. */
function jsonUtf8ByteLength(value: unknown): number | null {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return null;
  }
  if (json === undefined) return null;

  let bytes = 0;
  for (let index = 0; index < json.length; index += 1) {
    const codeUnit = json.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdbff &&
      index + 1 < json.length
    ) {
      const next = json.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * The canonical inline/invalidate decision. Producers and runtime validation
 * share this helper so the 64 KiB boundary cannot drift between call sites.
 */
export function shouldInlineNodeUiProjection(
  projection: NodeUiProjection,
): boolean {
  const bytes = jsonUtf8ByteLength(projection);
  return bytes !== null && bytes <= CANVAS_COMMIT_INLINE_NODE_MAX_BYTES;
}

const inlineNodeChangeSchema = z
  .object({
    kind: z.literal('inline'),
    nodeId: z.string().min(1),
    /** Opaque revision over the complete canonical node record. */
    recordRevision: z.string().min(1),
    projection: nodeUiProjectionSchema,
  })
  .strict();

const invalidateNodeChangeSchema = z
  .object({
    kind: z.literal('invalidate'),
    nodeId: z.string().min(1),
    /** Revision receivers should observe after re-fetching this node. */
    recordRevision: z.string().min(1),
  })
  .strict();

const deleteNodeChangeSchema = z
  .object({
    kind: z.literal('delete'),
    nodeId: z.string().min(1),
  })
  .strict();

/** One per-node consequence of a committed mutation. */
export const nodeChangeSchema = z
  .discriminatedUnion('kind', [
    inlineNodeChangeSchema,
    invalidateNodeChangeSchema,
    deleteNodeChangeSchema,
  ])
  .superRefine((change, context) => {
    if (
      change.kind === 'inline' &&
      !shouldInlineNodeUiProjection(change.projection)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['projection'],
        message: `Inline node projection exceeds ${CANVAS_COMMIT_INLINE_NODE_MAX_BYTES} UTF-8 JSON bytes; emit invalidate instead`,
      });
    }
  });
export type NodeChange = z.infer<typeof nodeChangeSchema>;

const canvasVersionSchema = z.number().int().nonnegative();
const opaqueRevisionSchema = z.string().min(1);

/**
 * Canonical broadcast payload for every committed Space mutation.
 * `commitId` is minted by the server and is never accepted on mutation
 * requests as an idempotency key.
 */
export const canvasCommitEventSchema = z
  .object({
    commitId: z.string().min(1),
    fromVersion: canvasVersionSchema,
    toVersion: canvasVersionSchema,
    structureRevision: opaqueRevisionSchema,
    originator: executeOriginatorSchema,
    /** True when the originating client already applied this mutation. */
    optimistic: z.boolean(),
    /** Whether the canonical Space record changed during the commit. */
    recordChanged: z.boolean(),
    structureDeltas: z.array(z.unknown()),
    /** Post-commit title, included only when it changed. */
    title: z.string().nullable().optional(),
    /** Post-commit node order, included only when it changed. */
    nodeOrder: z.array(z.string()).optional(),
    /** Post-commit edge order, included only when it changed. */
    edgeOrder: z.array(z.string()).optional(),
    nodeChanges: z.array(nodeChangeSchema),
  })
  .strict()
  .superRefine((event, context) => {
    const expectedToVersion = event.recordChanged
      ? event.fromVersion + 1
      : event.fromVersion;
    if (event.toVersion !== expectedToVersion) {
      context.addIssue({
        code: 'custom',
        path: ['toVersion'],
        message: event.recordChanged
          ? 'A changed commit must advance the version exactly once'
          : 'A no-op commit must not advance the version',
      });
    }
    if (
      !event.recordChanged &&
      (event.structureDeltas.length > 0 ||
        event.nodeChanges.length > 0 ||
        event.title !== undefined ||
        event.nodeOrder !== undefined ||
        event.edgeOrder !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['recordChanged'],
        message: 'A no-op commit cannot carry record changes',
      });
    }
  });
export type CanvasCommitEvent = z.infer<typeof canvasCommitEventSchema>;

/** Response metadata shared by mutation endpoints. */
export const mutationAckSchema = z
  .object({
    commitId: z.string().min(1),
    fromVersion: canvasVersionSchema,
    toVersion: canvasVersionSchema,
    structureRevision: opaqueRevisionSchema,
    recordChanged: z.boolean(),
  })
  .strict()
  .superRefine((ack, context) => {
    const expectedToVersion = ack.recordChanged
      ? ack.fromVersion + 1
      : ack.fromVersion;
    if (ack.toVersion !== expectedToVersion) {
      context.addIssue({
        code: 'custom',
        path: ['toVersion'],
        message: ack.recordChanged
          ? 'A changed commit must advance the version exactly once'
          : 'A no-op commit must not advance the version',
      });
    }
  });
export type MutationAck = z.infer<typeof mutationAckSchema>;

export const canvasSyncPendingEffectsSchema = z.object({
  /** Slim final topology nodes that were created or edited. */
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
      /**
       * The originating thread's durable review list changed. Consumers fetch
       * it from the dedicated thread-changes endpoint; full inverse deltas may
       * contain large authored bodies and therefore never belong on SSE.
       */
      changesInvalidated: z.literal(true).optional(),
      /**
       * Phase 4 commit metadata. Optional while legacy producers and
       * consumers continue using `deltas` + `pendingEffects` directly.
       */
      commit: canvasCommitEventSchema.optional(),
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
