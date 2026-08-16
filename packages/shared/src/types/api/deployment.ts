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
