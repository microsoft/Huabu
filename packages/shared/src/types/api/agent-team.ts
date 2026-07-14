import { z } from 'zod';

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

const agentTeamSetupErrorSchema = z
  .object({
    code: trimmedString(255),
    message: z.string(),
  })
  .strict();

const agentTeamDeploymentSetupSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('disabled') }).strict(),
  z
    .object({
      status: z.literal('setting_up'),
      operationId: idSchema,
      startedAt: timestampSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('ready'),
      completedAt: timestampSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('error'),
      failedAt: timestampSchema,
      error: agentTeamSetupErrorSchema,
    })
    .strict(),
]);

const agentTeamSetupPhaseSchema = z.enum([
  'validating_manifest',
  'preparing_workspace',
  'installing_tools',
  'installing_skills',
  'placing_prompt',
  'copying_files',
  'running_custom_setup',
]);

const agentTeamSetupLogEntrySchema = z
  .object({
    receivedAt: timestampSchema,
    phase: agentTeamSetupPhaseSchema,
    status: z.enum(['started', 'completed']),
    message: z.string(),
  })
  .strict();

export const agentTeamDeploymentSchema = agentTeamMemberRefSchema.extend({
  id: idSchema,
  alias: trimmedString(255),
  revision: z.number().int().positive(),
  enabled: z.boolean(),
  harness: trimmedString(255),
  workingDirPath: pathSchema,
  setup: agentTeamDeploymentSetupSchema,
  setupLog: z.array(agentTeamSetupLogEntrySchema),
});
export type AgentTeamDeploymentView = z.infer<typeof agentTeamDeploymentSchema>;

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

export const agentTeamSettingsStateSchema = z
  .object({
    roots: z.array(agentTeamRootSchema),
    members: z.array(agentTeamMemberSchema),
    deployments: z.array(agentTeamDeploymentSchema),
    configs: z.array(agentTeamMemberConfigSchema),
  })
  .strict();
export type AgentTeamSettingsState = z.infer<
  typeof agentTeamSettingsStateSchema
>;

export const createAgentTeamDeploymentBodySchema = agentTeamMemberRefSchema
  .extend({
    alias: trimmedString(255),
    harness: trimmedString(255),
    workingDirPath: pathSchema,
  })
  .strict();
export type CreateAgentTeamDeploymentBody = z.infer<
  typeof createAgentTeamDeploymentBodySchema
>;

export const updateAgentTeamDeploymentBodySchema = z
  .object({
    alias: trimmedString(255).optional(),
    harness: trimmedString(255).optional(),
    workingDirPath: pathSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one deployment field is required',
  });
export type UpdateAgentTeamDeploymentBody = z.infer<
  typeof updateAgentTeamDeploymentBodySchema
>;

export const agentTeamDeploymentParamsSchema = z
  .object({ id: idSchema })
  .strict();
export type AgentTeamDeploymentParams = z.infer<
  typeof agentTeamDeploymentParamsSchema
>;

export const updateAgentTeamMemberConfigsBodySchema = agentTeamMemberRefSchema
  .extend({
    values: z.record(trimmedString(255), z.string().max(65_536).nullable()),
  })
  .strict();
export type UpdateAgentTeamMemberConfigsBody = z.infer<
  typeof updateAgentTeamMemberConfigsBodySchema
>;

export const AGENT_TEAM_SETTINGS_SSE_EVENTS = {
  SNAPSHOT: 'snapshot',
  ERROR: 'state-error',
} as const;

export const agentTeamSettingsSseEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal(AGENT_TEAM_SETTINGS_SSE_EVENTS.SNAPSHOT),
      data: agentTeamSettingsStateSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal(AGENT_TEAM_SETTINGS_SSE_EVENTS.ERROR),
      data: z
        .object({
          message: z.string(),
          code: z.string().optional(),
        })
        .strict(),
    })
    .strict(),
]);
export type AgentTeamSettingsSseEvent = z.infer<
  typeof agentTeamSettingsSseEventSchema
>;
