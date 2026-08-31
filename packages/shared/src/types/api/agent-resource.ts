import { agentResourceSchema, resourceIdSchema } from '@agenetes/protocol';
import { z } from 'zod';

export type { AgentResource } from '@agenetes/protocol';

export const HUABU_REQUIRED_RESOURCE_IDS = [
  'huabu-access',
  'local-resource-management',
] as const;

export const agentResourceListResponseSchema = z
  .object({
    resources: z.array(agentResourceSchema),
  })
  .strict();
export type AgentResourceListResponse = z.infer<
  typeof agentResourceListResponseSchema
>;

export const localResourceReceiptRequestSchema = z
  .object({
    id: resourceIdSchema,
    kind: z.enum(['skill', 'tool', 'connector']),
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(2_000),
    instructions: z.string().trim().min(1).max(10_000),
    entrypoint: z.string().trim().min(1).max(4_096),
    source: z.string().trim().min(1).max(4_096).optional(),
  })
  .strict();
export type LocalResourceReceiptRequest = z.infer<
  typeof localResourceReceiptRequestSchema
>;

export const localResourceReceiptResponseSchema = z
  .object({
    resource: agentResourceSchema,
  })
  .strict();
export type LocalResourceReceiptResponse = z.infer<
  typeof localResourceReceiptResponseSchema
>;

export const localResourceRemovalResponseSchema = z
  .object({
    removed: z.boolean(),
  })
  .strict();
export type LocalResourceRemovalResponse = z.infer<
  typeof localResourceRemovalResponseSchema
>;
