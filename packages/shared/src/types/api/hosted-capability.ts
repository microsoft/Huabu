import { z } from 'zod';

export const RESOURCE_GRANT_HEADER = 'x-huabu-resource-grant';
export const RESOURCE_GRANT_ENV = 'HUABU_RESOURCE_GRANT';

export const webSearchInvocationInputSchema = z
  .object({
    query: z.string().trim().min(1).max(4_000),
    maxResults: z.number().int().min(1).max(10).optional(),
    searchDepth: z.enum(['basic', 'advanced']).optional(),
    includeAnswer: z.boolean().optional(),
  })
  .strict();
export type WebSearchInvocationInput = z.infer<
  typeof webSearchInvocationInputSchema
>;

export const imageGenerationInvocationInputSchema = z
  .object({
    prompt: z.string().trim().min(1).max(4_000),
    referenceArtifactSrcs: z
      .array(z.string().trim().min(1).max(4_096))
      .max(16)
      .optional(),
    size: z.string().trim().min(1).max(32).optional(),
    quality: z.enum(['low', 'medium', 'high', 'auto']).optional(),
  })
  .strict();
export type ImageGenerationInvocationInput = z.infer<
  typeof imageGenerationInvocationInputSchema
>;

export const hostedCapabilityInvokeRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    correlationId: z.string().trim().min(1).max(200).optional(),
    input: z.unknown(),
  })
  .strict();
export type HostedCapabilityInvokeRequest = z.infer<
  typeof hostedCapabilityInvokeRequestSchema
>;

export interface HostedCapabilityInvokeResponse {
  schemaVersion: 1;
  resourceId: string;
  correlationId?: string;
  result: unknown;
}
