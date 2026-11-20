// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { z } from 'zod';

import { FRAME_GRID_MAX_COUNT } from '../canvas/node.js';

export const frameLayoutOrderSchema = z
  .array(z.array(z.string().min(1)))
  .max(FRAME_GRID_MAX_COUNT)
  .refine((tracks) => {
    const ids = tracks.flat();
    return new Set(ids).size === ids.length;
  }, 'A child can occur only once in layoutOrder.');
export type FrameLayoutOrder = z.infer<typeof frameLayoutOrderSchema>;

export const frameLayoutPlacementSchema = z.union([
  z.object({ nodeId: z.string().min(1), before: z.string().min(1) }).strict(),
  z.object({ nodeId: z.string().min(1), after: z.string().min(1) }).strict(),
  z
    .object({
      nodeId: z.string().min(1),
      track: z
        .number()
        .int()
        .min(0)
        .max(FRAME_GRID_MAX_COUNT - 1),
      at: z.enum(['start', 'end']),
    })
    .strict(),
]);
export type FrameLayoutPlacement = z.infer<typeof frameLayoutPlacementSchema>;

export const frameLayoutDescriptionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('column'), tracks: frameLayoutOrderSchema }),
  z.object({ mode: z.literal('row'), tracks: frameLayoutOrderSchema }),
  z.object({
    mode: z.literal('grid'),
    cells: z.array(
      z.object({
        nodeId: z.string(),
        column: z.number().int().nonnegative(),
        row: z.number().int().nonnegative(),
      }),
    ),
  }),
]);
export type FrameLayoutDescription = z.infer<
  typeof frameLayoutDescriptionSchema
>;
