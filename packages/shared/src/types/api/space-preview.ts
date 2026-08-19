// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { z } from 'zod';

export const SPACE_PREVIEW_MAX_NODES = 250;
export const SPACE_PREVIEW_MAX_EDGES = 400;
export const SPACE_PREVIEW_MAX_RESPONSE_BYTES = 1024 * 1024;
export const SPACE_PREVIEW_MAX_TEXT_LENGTH = 2000;
export const SPACE_PREVIEW_MAX_IMAGE_SRC_LENGTH = 2048;

const canvasIdSchema = z.string().regex(/^canvas-.+$/);
const nodeIdSchema = z.string().regex(/^node-.+$/);

export const spacePreviewBoundsSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().nonnegative(),
    height: z.number().finite().nonnegative(),
  })
  .strict();

export const spacePreviewSceneNodeSchema = z
  .object({
    id: nodeIdSchema,
    kind: z.enum(['content', 'frame', 'nested-preview']),
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
    label: z.string().max(160).optional(),
    previewText: z.string().max(SPACE_PREVIEW_MAX_TEXT_LENGTH).optional(),
    imageSrc: z.string().max(SPACE_PREVIEW_MAX_IMAGE_SRC_LENGTH).optional(),
  })
  .strict();

export const spacePreviewSceneEdgeSchema = z
  .object({
    id: z.string().min(1),
    source: nodeIdSchema,
    target: nodeIdSchema,
    label: z.string().max(160).optional(),
  })
  .strict();

export const getSpacePreviewSceneResponseSchema = z
  .object({
    canvasId: canvasIdSchema,
    title: z.string().nullable(),
    version: z.number().int().nonnegative(),
    bounds: spacePreviewBoundsSchema,
    nodes: z.array(spacePreviewSceneNodeSchema).max(SPACE_PREVIEW_MAX_NODES),
    edges: z.array(spacePreviewSceneEdgeSchema).max(SPACE_PREVIEW_MAX_EDGES),
    truncated: z
      .object({
        nodes: z.boolean(),
        edges: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type SpacePreviewBounds = z.infer<typeof spacePreviewBoundsSchema>;
export type SpacePreviewSceneNode = z.infer<typeof spacePreviewSceneNodeSchema>;
export type SpacePreviewSceneEdge = z.infer<typeof spacePreviewSceneEdgeSchema>;
export type GetSpacePreviewSceneResponse = z.infer<
  typeof getSpacePreviewSceneResponseSchema
>;
