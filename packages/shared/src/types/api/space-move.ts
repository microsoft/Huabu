// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { z } from 'zod';

export const moveSelectionBodySchema = z
  .object({
    selectedNodeIds: z.array(z.string().min(1)).min(1),
    destination: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('existing'),
          canvasId: z.string().min(1),
        })
        .strict(),
      z
        .object({
          kind: z.literal('new'),
          title: z.string().trim().min(1),
        })
        .strict(),
    ]),
    createSourcePreview: z.boolean(),
    expectedSourceVersion: z.number().int().nonnegative(),
  })
  .strict();
export type MoveSelectionBody = z.infer<typeof moveSelectionBodySchema>;

export const moveSelectionErrorCodeSchema = z.enum([
  'MOVE_SOURCE_STALE',
  'MOVE_SOURCE_NODE_MISSING',
  'MOVE_NODE_NOT_MOVABLE',
  'MOVE_DESTINATION_MISSING',
  'MOVE_DESTINATION_SAME_AS_SOURCE',
  'MOVE_DESTINATION_CREATE_FAILED',
  'MOVE_DESTINATION_CLEANUP_FAILED',
  'MOVE_WORLD_NOT_ALLOWED',
  'MOVE_AGENT_RUNNING',
  'MOVE_AGENT_TASK_OWNED',
  'MOVE_AGENT_PENDING_CHANGES',
  'MOVE_AGENT_HISTORY_INVALID',
  'MOVE_ARTIFACT_MISSING',
  'MOVE_DESTINATION_CONFLICT',
  'MOVE_COMPENSATION_FAILED',
  'MOVE_OUTCOME_UNKNOWN',
]);
export type MoveSelectionErrorCode = z.infer<
  typeof moveSelectionErrorCodeSchema
>;

const movedRootSchema = z
  .object({
    sourceNodeId: z.string().min(1),
    destinationNodeId: z.string().min(1),
    label: z.string(),
  })
  .strict();

const omittedBoundaryEdgeSchema = z
  .object({
    edgeId: z.string().min(1),
    source: z.string().min(1),
    target: z.string().min(1),
  })
  .strict();

const renamedNodeSchema = z
  .object({
    sourceNodeId: z.string().min(1),
    from: z.string(),
    to: z.string(),
  })
  .strict();

export const moveSelectionResponseSchema = z
  .object({
    transferId: z.string().min(1),
    destination: z
      .object({
        canvasId: z.string().min(1),
        title: z.string().nullable(),
        created: z.boolean(),
      })
      .strict(),
    sourcePreviewNodeId: z.string().min(1).nullable(),
    sourceVersion: z.number().int().nonnegative(),
    destinationVersion: z.number().int().nonnegative(),
    roots: z.array(movedRootSchema),
    movedNodeCount: z.number().int().nonnegative(),
    movedFrameCount: z.number().int().nonnegative(),
    preservedEdgeCount: z.number().int().nonnegative(),
    omittedBoundaryEdges: z.array(omittedBoundaryEdgeSchema),
    renamedNodes: z.array(renamedNodeSchema),
    movedConversationCount: z.number().int().nonnegative(),
  })
  .strict();
export type MoveSelectionResponse = z.infer<typeof moveSelectionResponseSchema>;
