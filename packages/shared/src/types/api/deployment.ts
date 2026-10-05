// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { z } from 'zod';

export const deploymentReadinessIssueSchema = z.object({
  code: z.enum(['CREDENTIAL_STORE_READ_ONLY', 'REMOTE_HTTP_UNVERIFIED']),
  severity: z.enum(['warning', 'error']),
});
export type DeploymentReadinessIssue = z.infer<
  typeof deploymentReadinessIssueSchema
>;

export const deploymentReadinessResponseSchema = z.object({
  bind: z.object({
    host: z.string(),
    scope: z.enum(['loopback', 'network']),
  }),
  access: z.object({
    allowedHostsConfigured: z.boolean(),
    basicAuthConfigured: z.boolean(),
  }),
  owner: z.object({
    policy: z.literal('loopback-or-basic-auth'),
    allowedForRequest: z.boolean(),
  }),
  credentials: z.object({
    writable: z.boolean(),
    reason: z.enum(['available', 'secret-key-required']),
  }),
  transport: z.object({
    status: z.literal('operator-unverified'),
  }),
  issues: z.array(deploymentReadinessIssueSchema),
});
export type DeploymentReadinessResponse = z.infer<
  typeof deploymentReadinessResponseSchema
>;

export const canaryRedeployStateSchema = z.enum([
  'requested',
  'running',
  'succeeded',
  'failed',
]);
export type CanaryRedeployState = z.infer<typeof canaryRedeployStateSchema>;

export const canaryBranchSchema = z.string().trim().min(1).max(255);
export type CanaryBranch = z.infer<typeof canaryBranchSchema>;

export const canaryRedeployResultSchema = z.object({
  state: canaryRedeployStateSchema,
  branch: canaryBranchSchema,
  startedAt: z.number().int().nonnegative(),
  completedAt: z.number().int().nonnegative().optional(),
  exitCode: z.number().int().optional(),
  message: z.string().max(500).optional(),
});
export type CanaryRedeployResult = z.infer<typeof canaryRedeployResultSchema>;

export const canaryRedeployStatusResponseSchema = z.object({
  available: z.boolean(),
  reason: z.enum([
    'available',
    'disabled',
    'repository-unavailable',
    'script-unavailable',
  ]),
  branch: canaryBranchSchema,
  configuredBranch: canaryBranchSchema.nullable(),
  runningSha: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .nullable(),
  remoteSha: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .nullable(),
  updateAvailable: z.boolean().nullable(),
  checkedAt: z.number().int().nonnegative().nullable(),
  redeploy: canaryRedeployResultSchema.nullable(),
});
export type CanaryRedeployStatusResponse = z.infer<
  typeof canaryRedeployStatusResponseSchema
>;

export const canaryCheckRequestSchema = z.object({}).strict();
export type CanaryCheckRequest = z.infer<typeof canaryCheckRequestSchema>;

export const canaryRedeployConfigUpdateSchema = z
  .object({
    branch: canaryBranchSchema.nullable(),
  })
  .strict();
export type CanaryRedeployConfigUpdate = z.infer<
  typeof canaryRedeployConfigUpdateSchema
>;

export const canaryRedeployRequestSchema = z
  .object({
    expectedBranch: canaryBranchSchema,
  })
  .strict();
export type CanaryRedeployRequest = z.infer<typeof canaryRedeployRequestSchema>;
