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
    manageableResourceIds: z.array(resourceIdSchema).optional(),
  })
  .strict();
export type AgentResourceListResponse = z.infer<
  typeof agentResourceListResponseSchema
>;

export const agentResourceIdParamsSchema = z
  .object({ resourceId: resourceIdSchema })
  .strict();
export type AgentResourceIdParams = z.infer<typeof agentResourceIdParamsSchema>;

export const scanAgentResourcesBodySchema = z
  .object({
    rootPath: z.string().trim().min(1).max(4_096),
  })
  .strict();
export type ScanAgentResourcesBody = z.infer<
  typeof scanAgentResourcesBodySchema
>;

export const agentResourceImportCandidateSchema = z
  .object({
    id: resourceIdSchema,
    name: z.string().trim().min(1).max(128),
    sourcePath: z.string().trim().min(1).max(4_096),
    sourceContent: z.string().trim().min(1).max(100_000),
    sourceRevision: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type AgentResourceImportCandidate = z.infer<
  typeof agentResourceImportCandidateSchema
>;

export const agentResourceScanDiagnosticSchema = z
  .object({
    path: z.string(),
    code: z.enum(['skill_unreadable', 'skill_invalid']),
    message: z.string(),
  })
  .strict();

export const scanAgentResourcesResponseSchema = z
  .object({
    rootPath: z.string(),
    candidates: z.array(agentResourceImportCandidateSchema).max(256),
    diagnostics: z.array(agentResourceScanDiagnosticSchema).max(256),
  })
  .strict();
export type ScanAgentResourcesResponse = z.infer<
  typeof scanAgentResourcesResponseSchema
>;

export const importAgentResourceBodySchema = z
  .object({
    id: resourceIdSchema,
    sourcePath: z.string().trim().min(1).max(4_096),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
    displayName: z.string().trim().min(1).max(128).optional(),
    userContent: z.string().trim().max(20_000).default(''),
  })
  .strict();
export type ImportAgentResourceBody = z.infer<
  typeof importAgentResourceBodySchema
>;

export const patchAgentResourceBodySchema = z
  .object({
    displayName: z.string().trim().min(1).max(128).nullable().optional(),
    userContent: z.string().trim().max(20_000).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.displayName !== undefined || value.userContent !== undefined,
    { message: 'At least one resource field must be provided' },
  );
export type PatchAgentResourceBody = z.infer<
  typeof patchAgentResourceBodySchema
>;

export const refreshAgentResourceBodySchema = z
  .object({
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type RefreshAgentResourceBody = z.infer<
  typeof refreshAgentResourceBodySchema
>;

export const agentResourceMutationResponseSchema = z
  .object({ resource: agentResourceSchema })
  .strict();
export type AgentResourceMutationResponse = z.infer<
  typeof agentResourceMutationResponseSchema
>;

export const localResourceReceiptRequestSchema = z
  .object({
    id: resourceIdSchema,
    kind: z.enum(['skill', 'tool', 'connector']),
    name: z.string().trim().min(1).max(200),
    sourceContent: z.string().trim().min(1).max(100_000),
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
