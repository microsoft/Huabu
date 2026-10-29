// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { z } from 'zod';

const spaceId = z.string().regex(/^[a-zA-Z0-9_-]+$/);
const entryPositionSchema = z
  .object({ x: z.number().finite(), y: z.number().finite() })
  .strict();
export const spaceHierarchyParamsSchema = z.object({ canvasId: spaceId });
export const spaceParentBodySchema = z
  .object({
    parentSpaceId: spaceId.nullable(),
    expectedParentSpaceId: spaceId.nullable(),
    position: entryPositionSchema.optional(),
  })
  .strict()
  .refine((body) => !body.position || body.parentSpaceId !== null, {
    message: 'A position requires a parent Space',
  });
export type SpaceParentBody = z.infer<typeof spaceParentBodySchema>;

export const createChildSpaceBodySchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    position: entryPositionSchema.optional(),
  })
  .strict();
export type CreateChildSpaceBody = z.infer<typeof createChildSpaceBodySchema>;
export const spaceHierarchyResponseSchema = z.object({
  canvasId: spaceId,
  parentSpaceId: spaceId.nullable(),
  parentEntryNodeId: z.string().nullable(),
});
export type SpaceHierarchyResponse = z.infer<
  typeof spaceHierarchyResponseSchema
>;

export const deleteSpaceTreePreviewSchema = z.object({
  token: z.string(),
  spaces: z.array(
    z.object({ canvasId: spaceId, title: z.string().nullable() }),
  ),
});
export type DeleteSpaceTreePreview = z.infer<
  typeof deleteSpaceTreePreviewSchema
>;
export const deleteSpaceTreeBodySchema = z
  .object({ token: z.string().min(1) })
  .strict();
export const deleteSpaceTreeResponseSchema = z.object({
  deletedCanvasIds: z.array(spaceId),
});
export type DeleteSpaceTreeResponse = z.infer<
  typeof deleteSpaceTreeResponseSchema
>;

export const deleteSpaceTreeFailureSchema = z.object({
  deletedCanvasIds: z.array(spaceId),
  remainingCanvasIds: z.array(spaceId),
  cause: z.string(),
});
export type DeleteSpaceTreeFailure = z.infer<
  typeof deleteSpaceTreeFailureSchema
>;
