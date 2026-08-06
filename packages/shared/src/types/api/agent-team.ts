// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { z } from 'zod';

import { agentTeamManifestProfileDetailSchema } from './agent-profile.js';

const trimmedString = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim() === value, {
      message: 'Must not contain surrounding whitespace',
    });

const machineSchema = trimmedString(255);
const pathSchema = trimmedString(4096).refine(
  (value) =>
    value.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith('\\\\'),
  { message: 'Must be an absolute path' },
);
const idSchema = trimmedString(255);
const timestampSchema = z.number().int().nonnegative();

export const agentTeamRootRefSchema = z
  .object({
    machine: machineSchema,
    path: pathSchema,
  })
  .strict();
export type AgentTeamRootRefBody = z.infer<typeof agentTeamRootRefSchema>;

export const agentTeamMemberRefSchema = z
  .object({
    machine: machineSchema,
    manifestPath: pathSchema,
  })
  .strict();
export type AgentTeamMemberRefBody = z.infer<typeof agentTeamMemberRefSchema>;

export const agentTeamMachineSchema = z
  .object({
    machine: machineSchema,
    hostname: trimmedString(255),
    platform: trimmedString(255),
  })
  .strict();
export type AgentTeamMachineView = z.infer<typeof agentTeamMachineSchema>;

const agentTeamDiagnosticSchema = z
  .object({
    manifestPath: pathSchema,
    code: z.enum(['invalid_manifest', 'manifest_unreadable']),
    message: z.string(),
  })
  .strict();

const agentTeamRootScanSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('never_scanned') }).strict(),
  z
    .object({
      status: z.literal('success'),
      scannedAt: timestampSchema,
      diagnostics: z.array(agentTeamDiagnosticSchema),
    })
    .strict(),
  z
    .object({
      status: z.literal('error'),
      attemptedAt: timestampSchema,
      message: z.string(),
    })
    .strict(),
]);

export const agentTeamRootSchema = agentTeamRootRefSchema.extend({
  scan: agentTeamRootScanSchema,
});
export type AgentTeamRootView = z.infer<typeof agentTeamRootSchema>;

const agentTeamEnvFieldSchema = z
  .object({
    name: trimmedString(255),
    description: z.string(),
    required: z.boolean(),
    secret: z.boolean(),
    default: z.string().optional(),
  })
  .strict();

export const agentTeamMemberSchema = agentTeamMemberRefSchema.extend({
  name: trimmedString(255),
  description: z.string(),
  harnesses: z.array(trimmedString(255)),
  env: z.array(agentTeamEnvFieldSchema),
  discoveredBy: z.array(agentTeamRootRefSchema),
  status: z.enum(['active', 'member_missing']),
});
export type AgentTeamMemberView = z.infer<typeof agentTeamMemberSchema>;

const agentTeamConfigFieldSchema = z
  .object({
    name: trimmedString(255),
    description: z.string(),
    required: z.boolean(),
    secret: z.boolean(),
    configured: z.boolean(),
    value: z.string().optional(),
  })
  .strict();

export const agentTeamMemberConfigSchema = agentTeamMemberRefSchema.extend({
  fields: z.array(agentTeamConfigFieldSchema),
  missingRequired: z.array(trimmedString(255)),
  ready: z.boolean(),
});
export type AgentTeamMemberConfigView = z.infer<
  typeof agentTeamMemberConfigSchema
>;

const preparationCountsSchema = z
  .object({
    not_prepared: z.number().int().nonnegative(),
    setting_up: z.number().int().nonnegative(),
    ready: z.number().int().nonnegative(),
    error: z.number().int().nonnegative(),
  })
  .strict();

export const agentTeamMemberSummarySchema = agentTeamMemberRefSchema.extend({
  name: trimmedString(255),
  description: z.string(),
  status: z.enum(['active', 'member_missing']),
  profileCount: z.number().int().nonnegative(),
  preparationCounts: preparationCountsSchema,
});
export type AgentTeamMemberSummaryView = z.infer<
  typeof agentTeamMemberSummarySchema
>;

export const agentTeamMemberDetailSchema = z
  .object({
    member: agentTeamMemberSchema,
    config: agentTeamMemberConfigSchema,
    profiles: z.array(agentTeamManifestProfileDetailSchema),
  })
  .strict();
export type AgentTeamMemberDetailView = z.infer<
  typeof agentTeamMemberDetailSchema
>;

export const agentTeamSettingsStateSchema = z
  .object({
    machines: z.array(agentTeamMachineSchema),
    localMachine: machineSchema,
    roots: z.array(agentTeamRootSchema),
    members: z.array(agentTeamMemberSummarySchema),
  })
  .strict();
export type AgentTeamSettingsState = z.infer<
  typeof agentTeamSettingsStateSchema
>;

export const agentTeamMemberDetailQuerySchema = agentTeamMemberRefSchema;
export type AgentTeamMemberDetailQuery = z.infer<
  typeof agentTeamMemberDetailQuerySchema
>;

export const updateAgentTeamMemberConfigsBodySchema = agentTeamMemberRefSchema
  .extend({
    values: z.record(trimmedString(255), z.string().max(65_536).nullable()),
  })
  .strict();
export type UpdateAgentTeamMemberConfigsBody = z.infer<
  typeof updateAgentTeamMemberConfigsBodySchema
>;

export const agentTeamProfileActionParamsSchema = z
  .object({ id: idSchema })
  .strict();
export type AgentTeamProfileActionParams = z.infer<
  typeof agentTeamProfileActionParamsSchema
>;
