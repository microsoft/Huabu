// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { z } from 'zod';

import { agentIconSchema } from './agent-profile.js';
import { agentBindingSchema } from './agent.js';
import { recentCanvasConversationParamsSchema } from './canvas.js';

export const spaceCardQuerySchema = z.object({
  canvasIds: z
    .array(recentCanvasConversationParamsSchema.shape.canvasId)
    .min(1)
    .max(50),
});
export type SpaceCardQuery = z.infer<typeof spaceCardQuerySchema>;

export const spaceCardAgentSchema = z.object({
  nodeId: z.string().min(1),
  threadId: z.string().min(1),
  title: z.string().nullable(),
  agentBinding: agentBindingSchema.optional(),
  agentIcon: agentIconSchema.optional(),
  agentMode: z.enum(['ask', 'operate']).optional(),
  status: z.enum(['running', 'approval', 'error', 'unread', 'unknown', 'idle']),
});
export type SpaceCardAgent = z.infer<typeof spaceCardAgentSchema>;
export const spaceAgentActivitySchema = z.array(spaceCardAgentSchema);
export type SpaceAgentActivity = z.infer<typeof spaceAgentActivitySchema>;

export const spaceCardSnapshotSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ready'),
    title: z.string().nullable(),
    updatedAt: z.number(),
    activity: spaceAgentActivitySchema,
  }),
  z.object({ status: z.literal('missing') }),
  z.object({ status: z.literal('error') }),
]);
export type SpaceCardSnapshot = z.infer<typeof spaceCardSnapshotSchema>;
export const spaceCardQueryResponseSchema = z.object({
  spaces: z.record(z.string(), spaceCardSnapshotSchema),
});
export type SpaceCardQueryResponse = z.infer<
  typeof spaceCardQueryResponseSchema
>;

export const renameSpaceBodySchema = z.object({
  title: z.string().trim().min(1),
  expectedTitle: z.string().nullable(),
});
export type RenameSpaceBody = z.infer<typeof renameSpaceBodySchema>;
export const renameSpaceResponseSchema = z.object({
  title: z.string().nullable(),
  updatedAt: z.number(),
});
export type RenameSpaceResponse = z.infer<typeof renameSpaceResponseSchema>;
