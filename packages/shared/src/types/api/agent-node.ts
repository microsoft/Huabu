// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { z } from 'zod';

import { agentBindingSchema } from './agent.js';

export const agentNodeBindingStateSchema = z.enum(['editing', 'bound']);
export type AgentNodeBindingState = z.infer<typeof agentNodeBindingStateSchema>;
export const agentNodeInvocationTokenSchema = z.string().min(1);
export const agentNodeLaunchOverridesSchema = z
  .object({
    workingDirPath: z.string().optional(),
    additionalInitialPreamble: z.string().optional(),
  })
  .strict();
export type AgentNodeLaunchOverrides = z.infer<
  typeof agentNodeLaunchOverridesSchema
>;

/** Bounded ownership contract; unrelated node data retains its existing shape. */
export const canvasEditableNodeDataSchema = z
  .object({
    bindingState: z.never().optional(),
    status: z.never().optional(),
    errorMessage: z.never().optional(),
    invocationToken: z.never().optional(),
    viewed: z.never().optional(),
    threadId: z.never().optional(),
    conversationTitleSource: z.never().optional(),
    agentBinding: agentBindingSchema.optional(),
    agentLaunchOverrides: agentNodeLaunchOverridesSchema.nullable().optional(),
  })
  .catchall(z.unknown());
export type CanvasEditableNodeData = z.infer<
  typeof canvasEditableNodeDataSchema
>;

const canvasNodeEditBaseSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().optional(),
    data: z.record(z.string(), z.unknown()).optional(),
    position: z.object({ x: z.number(), y: z.number() }).optional(),
    parentId: z.string().nullable().optional(),
  })
  .catchall(z.unknown());
export const canvasEditableNodeSchema = canvasNodeEditBaseSchema.superRefine(
  (node, ctx) => {
    if (node.type !== 'question' || !node.data) return;
    const parsed = canvasEditableNodeDataSchema.safeParse(node.data);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({ ...issue, path: ['data', ...issue.path] });
      }
    }
  },
);
export type CanvasEditableNode = z.infer<typeof canvasEditableNodeSchema>;

export const associateAgentNodeParamsSchema = z
  .object({
    canvasId: z.string().min(1),
    nodeId: z.string().min(1),
  })
  .strict();
export const associateAgentNodeBodySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('initialize') }).strict(),
  z
    .object({
      kind: z.literal('restore'),
      node: canvasNodeEditBaseSchema.extend({
        type: z.literal('question'),
        data: canvasEditableNodeDataSchema.optional(),
        position: z.object({ x: z.number(), y: z.number() }),
      }),
      threadId: z.string().min(1).optional(),
      requireBinding: z.boolean(),
    })
    .strict(),
]);
export type AssociateAgentNodeBody = z.infer<
  typeof associateAgentNodeBodySchema
>;
export const associateAgentNodeResponseSchema = z
  .object({
    /** Complete read model, like the nodes in Canvas execution responses. */
    node: z.unknown(),
    fromVersion: z.number(),
    toVersion: z.number(),
  })
  .strict();
export type AssociateAgentNodeResponse = z.infer<
  typeof associateAgentNodeResponseSchema
>;

export const acknowledgeAgentNodeResultBodySchema = z
  .object({
    /** Null acknowledges a legacy terminal result only while its token is absent. */
    invocationToken: agentNodeInvocationTokenSchema.nullable(),
  })
  .strict();
export type AcknowledgeAgentNodeResultBody = z.infer<
  typeof acknowledgeAgentNodeResultBodySchema
>;
export const acknowledgeAgentNodeResultResponseSchema = z
  .object({
    acknowledged: z.boolean(),
  })
  .strict();
export type AcknowledgeAgentNodeResultResponse = z.infer<
  typeof acknowledgeAgentNodeResultResponseSchema
>;

/** Internal business projection, not accepted by an ordinary Canvas route. */
export const agentNodeProjectionSchema = z
  .object({
    threadId: z.string().min(1),
    expectedInvocationToken: agentNodeInvocationTokenSchema.optional(),
    bindingState: agentNodeBindingStateSchema.optional(),
    invocationToken: agentNodeInvocationTokenSchema.optional(),
    status: z.enum(['idle', 'running', 'done', 'error']).optional(),
    errorMessage: z.string().optional(),
    viewed: z.boolean().optional(),
    initialContent: z.string().optional(),
  })
  .strict();
export type AgentNodeProjection = z.infer<typeof agentNodeProjectionSchema>;
