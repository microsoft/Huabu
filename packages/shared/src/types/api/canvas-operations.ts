// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { z } from 'zod';

import { putNodeContentBodySchema } from './canvas.js';
import {
  mergeNodeDataCommandSchema,
  reorderNodesCommandSchema,
  nodeStyleSchema,
  edgeStyleSchema,
  setNodeGeometryCommandSchema,
  createNodesCommandSchema,
  deleteNodesCommandSchema,
} from './space-operations.js';
import { isSetSiblingOrderEvent } from '../../canvas-engine/siblingOrder.js';
import { ACCENT_PALETTE, CANVAS_NODE_TYPES } from '../canvas/index.js';

import type { SetSiblingOrderEvent } from '../../canvas-engine/siblingOrder.js';

const versionSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const tokenSchema = z.string().min(1).max(256);
const pointSchema = z.object({ x: z.number(), y: z.number() }).strict();
const accentSchema = z
  .enum(ACCENT_PALETTE.map(({ token }) => token))
  .nullable();

const lifecycleIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9_-]+$/)
  .max(128);
const retiredLifetimeSchema = z
  .object({
    incarnation: tokenSchema,
    deletedVersion: versionSchema,
  })
  .strict();
export const canvasLifecycleCreateCommandSchema = createNodesCommandSchema
  .extend({
    nodes: z
      .array(
        createNodesCommandSchema.shape.nodes.element
          .extend({
            id: lifecycleIdSchema.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();

export const canvasOperationCommandSchema = z.union([
  setNodeGeometryCommandSchema,
  mergeNodeDataCommandSchema,
  reorderNodesCommandSchema,
  canvasLifecycleCreateCommandSchema,
  deleteNodesCommandSchema,
]);

export const canvasOperationGuardSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('delete'),
      commandIndex: versionSchema,
      nodeId: lifecycleIdSchema,
      incarnation: tokenSchema,
      membershipVersion: versionSchema,
      coordinateContext: tokenSchema,
      fieldVersions: z
        .object({ position: versionSchema, 'style.accent': versionSchema })
        .strict(),
      expectRev: tokenSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('node'),
      commandIndex: versionSchema,
      nodeId: tokenSchema,
      incarnation: tokenSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('coordinates'),
      commandIndex: versionSchema,
      nodeId: tokenSchema,
      incarnation: tokenSchema,
      parentId: tokenSchema.nullable(),
      membershipVersion: versionSchema,
      coordinateContext: tokenSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('membership'),
      commandIndex: versionSchema,
      nodeId: tokenSchema,
      incarnation: tokenSchema,
      parentId: tokenSchema.nullable(),
      membershipVersion: versionSchema,
    })
    .strict(),
]);

export const canvasOperationRequestSchema = z
  .object({
    protocolVersion: z.literal(1),
    spaceEpoch: z.uuid(),
    sessionId: z.uuid(),
    operationId: z.uuid(),
    observedVersion: versionSchema,
    mode: z.enum(['atomic', 'partial']),
    commands: z.array(canvasOperationCommandSchema).min(1).max(50),
    preconditions: z.array(canvasOperationGuardSchema).max(1000),
  })
  .strict();
export type CanvasOperationRequest = z.infer<
  typeof canvasOperationRequestSchema
>;

export const canvasContentOperationRequestSchema = canvasOperationRequestSchema
  .pick({
    protocolVersion: true,
    spaceEpoch: true,
    sessionId: true,
    operationId: true,
    observedVersion: true,
  })
  .extend({
    incarnation: tokenSchema,
    update: putNodeContentBodySchema
      .pick({ nodeType: true, content: true, expectRev: true })
      .required()
      .extend({ expectRev: tokenSchema, nodeType: z.enum(CANVAS_NODE_TYPES) })
      .strict(),
  })
  .strict();
export type CanvasContentOperationRequest = z.infer<
  typeof canvasContentOperationRequestSchema
>;

export const canvasReviewNotificationSchema = z
  .object({ spaceEpoch: z.uuid(), reviewRevision: versionSchema })
  .strict();
export const canvasOperationResultSchema = z
  .object({
    commandIndex: versionSchema,
    applied: z.boolean(),
    reason: z
      .enum([
        'no-change',
        'stale-target',
        'stale-parent',
        'stale-context',
        'locked',
        'unsupported-command',
        'invalid-guard',
        'atomic-rejected',
        'content-conflict',
        'id-conflict',
        'stale-delete',
      ])
      .optional(),
    nodeId: tokenSchema.optional(),
    contentRevision: tokenSchema.optional(),
    nodeIds: z.array(lifecycleIdSchema).max(50).optional(),
  })
  .strict();

function presence<T extends z.ZodType>(schema: T) {
  return z.union([
    z.object({ present: z.literal(false) }).strict(),
    z.object({ present: z.literal(true), value: schema }).strict(),
  ]);
}

export const canvasNodeFieldChangeSchema = z.discriminatedUnion('field', [
  z
    .object({
      field: z.literal('position'),
      before: presence(pointSchema),
      after: presence(pointSchema),
    })
    .strict(),
  z
    .object({
      field: z.literal('style.accent'),
      before: presence(accentSchema),
      after: presence(accentSchema),
    })
    .strict(),
]);

export const canvasNodePatchEventSchema = z
  .object({
    type: z.literal('PATCH_NODE'),
    nodeId: tokenSchema,
    incarnation: tokenSchema,
    context: z
      .object({
        parentId: tokenSchema.nullable(),
        membershipVersion: versionSchema,
        coordinateContext: tokenSchema,
      })
      .strict()
      .optional(),
    changes: z.array(canvasNodeFieldChangeSchema).min(1),
  })
  .strict();
export const canvasSiblingOrderEventSchema = z.custom<SetSiblingOrderEvent>(
  isSetSiblingOrderEvent,
  'Invalid complete sibling-order event',
);
export const canvasLifecycleNodeSchema = z
  .object({
    id: lifecycleIdSchema,
    type: z.enum(['note', 'text', 'frame']),
    position: pointSchema,
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    style: z
      .object({
        width: z.number().positive().optional(),
        height: z.number().positive().optional(),
      })
      .strict()
      .optional(),
    data: z
      .object({
        type: z.enum(['note', 'text', 'frame']).optional(),
        style: nodeStyleSchema.optional(),
        heightMode: z.enum(['auto', 'fixed']).optional(),
        layoutMode: z.literal('free').optional(),
      })
      .strict(),
  })
  .strict();
export const canvasOperationEventSchema = z.union([
  canvasNodePatchEventSchema,
  canvasSiblingOrderEventSchema,
  z
    .object({
      type: z.literal('INSERT_NODE'),
      node: canvasLifecycleNodeSchema,
      incarnation: tokenSchema,
      contentRevision: tokenSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('REMOVE_NODE'),
      nodeId: lifecycleIdSchema,
      incarnation: tokenSchema,
      contentRevision: tokenSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('NODE_CONTENT_REVISION'),
      nodeId: tokenSchema,
      incarnation: tokenSchema,
      beforeRevision: tokenSchema,
      afterRevision: tokenSchema,
    })
    .strict(),
]);
export type CanvasOperationEvent = z.infer<typeof canvasOperationEventSchema>;

export const canvasOperationCommitSchema = z
  .object({
    spaceEpoch: z.uuid(),
    fromVersion: versionSchema,
    toVersion: versionSchema,
    sessionId: z.uuid(),
    operationId: z.uuid(),
    origin: z.object({ kind: z.enum(['ui', 'agent', 'system']) }).strict(),
    reviewRevision: versionSchema.optional(),
    reviewRecord: z
      .object({
        threadId: tokenSchema,
        changeIds: z.array(tokenSchema).min(1).max(50),
        recordsDigest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
    events: z.array(canvasOperationEventSchema).min(1),
    results: z.array(canvasOperationResultSchema).min(1).max(50),
  })
  .strict()
  .refine((value) => value.toVersion === value.fromVersion + 1, {
    message: 'A commit must advance exactly one version',
  });
export type CanvasOperationCommit = z.infer<typeof canvasOperationCommitSchema>;

const receiptIdentity = {
  spaceEpoch: z.uuid(),
  sessionId: z.uuid(),
  operationId: z.uuid(),
  results: z.array(canvasOperationResultSchema).min(1).max(50),
};
export const canvasOperationReceiptSchema = z.discriminatedUnion('status', [
  z
    .object({
      ...receiptIdentity,
      status: z.literal('committed'),
      commitVersion: versionSchema,
      commit: canvasOperationCommitSchema,
    })
    .strict(),
  z
    .object({
      ...receiptIdentity,
      status: z.enum(['noop', 'rejected']),
      atVersion: versionSchema,
      commit: z.null(),
    })
    .strict(),
]);
export type CanvasOperationReceipt = z.infer<
  typeof canvasOperationReceiptSchema
>;

export const canvasOperationSessionSchema = z
  .object({
    protocolVersion: z.literal(1),
    sessionId: z.uuid(),
    spaceEpoch: z.uuid(),
    modelVersion: z.literal(1),
    features: z.array(
      z.enum([
        'root-node-position',
        'root-node-accent',
        'root-node-order',
        'root-authored-content',
        'plain-root-lifecycle',
      ]),
    ),
    expiresAt: versionSchema,
    receiptsRetainedUntil: versionSchema,
    limits: z
      .object({
        maxCommands: z.literal(50),
        maxCommitBytes: z.literal(1048576),
        maxReplayCount: z.literal(200),
        maxReplayBytes: z.literal(4194304),
      })
      .strict(),
  })
  .strict()
  .refine(
    (session) =>
      session.receiptsRetainedUntil >= session.expiresAt + 7 * 86400000,
    {
      message: 'Receipts must outlive the lease by at least seven days',
    },
  );
export type CanvasOperationSession = z.infer<
  typeof canvasOperationSessionSchema
>;

export const canvasOperationLookupSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('terminal'),
      receipt: canvasOperationReceiptSchema,
    })
    .strict(),
  z.object({ status: z.enum(['pending', 'absent', 'expired']) }).strict(),
]);
export type CanvasOperationLookup = z.infer<typeof canvasOperationLookupSchema>;

export const canvasCommitQuerySchema = z
  .object({
    spaceEpoch: z.uuid(),
    afterVersion: versionSchema,
    throughVersion: versionSchema.optional(),
    limit: z.number().int().min(1).max(200).default(200),
    maxBytes: z.number().int().min(1).max(4194304).default(4194304),
  })
  .strict();
export type CanvasCommitQuery = z.infer<typeof canvasCommitQuerySchema>;

export const canvasCommitPageSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('snapshot-required'),
      spaceEpoch: z.uuid(),
      earliestReplayVersion: versionSchema,
      latestVersion: versionSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('commits'),
      spaceEpoch: z.uuid(),
      fromVersion: versionSchema,
      throughVersion: versionSchema,
      commits: z.array(canvasOperationCommitSchema).max(200),
      nextAfterVersion: versionSchema,
      hasMore: z.boolean(),
    })
    .strict(),
]);
export type CanvasCommitPage = z.infer<typeof canvasCommitPageSchema>;

export const canvasEntityVersionSchema = z
  .object({
    incarnation: tokenSchema,
    membershipVersion: versionSchema,
    coordinateContext: tokenSchema,
    fieldVersions: z.record(
      z.enum(['position', 'style.accent']),
      versionSchema,
    ),
  })
  .strict();

export const canvasOperationMetadataSchema = z
  .object({
    modelVersion: z.literal(1),
    spaceEpoch: z.uuid(),
    earliestReplayVersion: versionSchema,
    reviewRevision: versionSchema,
    retiredNodes: z.record(lifecycleIdSchema, retiredLifetimeSchema).optional(),
    nodes: z.record(tokenSchema, canvasEntityVersionSchema),
    siblingOrderVersions: z.array(
      z
        .object({ parentId: tokenSchema.nullable(), version: versionSchema })
        .strict(),
    ),
  })
  .strict();
export type CanvasOperationMetadata = z.infer<
  typeof canvasOperationMetadataSchema
>;

export const canvasOperationSessionBodySchema = z
  .object({
    protocolVersion: z.literal(1),
  })
  .strict();
export const canvasOperationLookupParamsSchema = z
  .object({
    canvasId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    operationId: z.uuid(),
  })
  .strict();
export const canvasOperationLookupQuerySchema = z
  .object({
    spaceEpoch: z.uuid(),
    sessionId: z.uuid(),
  })
  .strict();
export const canvasOperationSnapshotQuerySchema = z.object({}).strict();
export const canvasCommitHttpQuerySchema = canvasCommitQuerySchema.extend({
  afterVersion: z.coerce.number().pipe(versionSchema),
  throughVersion: z.coerce.number().pipe(versionSchema).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(200),
  maxBytes: z.coerce.number().int().min(1).max(4194304).default(4194304),
});
export const canvasOperationStreamQuerySchema = z
  .object({
    protocolVersion: z.literal('1'),
    spaceEpoch: z.uuid(),
    afterVersion: z.coerce.number().pipe(versionSchema),
  })
  .strict();
export type CanvasOperationStreamQuery = z.infer<
  typeof canvasOperationStreamQuerySchema
>;

export const canvasOperationStreamEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('review'),
      data: canvasReviewNotificationSchema,
    })
    .strict(),
  z
    .object({ type: z.literal('commit'), data: canvasOperationCommitSchema })
    .strict(),
  z
    .object({
      type: z.literal('ready'),
      data: z.object({ spaceEpoch: z.uuid(), version: versionSchema }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('recovery-required'),
      data: z
        .object({
          reason: z.enum([
            'snapshot-required',
            'buffer-overflow',
            'stream-gap',
            'storage-unavailable',
          ]),
        })
        .strict(),
    })
    .strict(),
]);
export type CanvasOperationStreamEvent = z.infer<
  typeof canvasOperationStreamEventSchema
>;

/** Common root-node structure only; bodies and type-owned data stay with their owners. */
export const canvasOperationSnapshotSchema = z
  .object({
    canvasId: tokenSchema,
    version: versionSchema,
    metadata: canvasOperationMetadataSchema,
    state: z.object({
      nodes: z.array(
        z.object({
          id: tokenSchema,
          type: z.enum(CANVAS_NODE_TYPES),
          position: pointSchema,
          parentId: z.null().optional(),
          width: z.number().positive().optional(),
          height: z.number().positive().optional(),
          data: z.object({
            style: nodeStyleSchema.optional(),
            locked: z.boolean().optional(),
            heightMode: z.enum(['auto', 'fixed']).optional(),
            layoutMode: z.enum(['free', 'column', 'row', 'grid']).optional(),
          }),
        }),
      ),
      edges: z.array(
        z.object({
          id: tokenSchema,
          source: tokenSchema,
          target: tokenSchema,
          style: edgeStyleSchema.optional(),
        }),
      ),
    }),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const ids = new Set(snapshot.state.nodes.map(({ id }) => id));
    const edges = new Set(snapshot.state.edges.map(({ id }) => id));
    const parents = new Set<string | null>([
      null,
      ...snapshot.state.nodes
        .filter(({ type }) => type === 'frame')
        .map(({ id }) => id),
    ]);
    const orders = snapshot.metadata.siblingOrderVersions;
    if (
      ids.size !== snapshot.state.nodes.length ||
      ids.size !== Object.keys(snapshot.metadata.nodes).length ||
      snapshot.state.nodes.some(({ id }) => !snapshot.metadata.nodes[id]) ||
      edges.size !== snapshot.state.edges.length ||
      snapshot.state.edges.some(
        ({ source, target }) => !ids.has(source) || !ids.has(target),
      ) ||
      snapshot.metadata.earliestReplayVersion > snapshot.version ||
      orders.length !== parents.size ||
      new Set(orders.map(({ parentId }) => parentId)).size !== parents.size ||
      orders.some(
        ({ parentId, version }) =>
          !parents.has(parentId) || version > snapshot.version,
      ) ||
      Object.values(snapshot.metadata.nodes).some(
        (meta) =>
          meta.membershipVersion > snapshot.version ||
          Object.values(meta.fieldVersions).some(
            (version) => version > snapshot.version,
          ),
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Snapshot topology, lifetimes and writer versions disagree',
      });
    }
  });
export type CanvasOperationSnapshot = z.infer<
  typeof canvasOperationSnapshotSchema
>;
