// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { z } from 'zod';

const trimmedString = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim() === value, {
      message: 'Must not contain surrounding whitespace',
    });

const pathSchema = trimmedString(4096).refine(
  (value) =>
    value.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith('\\\\'),
  { message: 'Must be an absolute path' },
);

/**
 * An arbitrary JSON value. Backs {@link customDataSchema}, the opaque
 * per-Profile bag agenetes stores verbatim without interpreting.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

/**
 * Caller-owned, opaque bag of JSON data carried on every Profile. Huabu uses
 * it for display preferences (see {@link agentIconSchema}); agenetes persists it
 * verbatim and never reads it.
 */
export const customDataSchema = z.record(z.string(), jsonValueSchema);
export type CustomData = z.infer<typeof customDataSchema>;

/** The basic-shape agent avatars. */
export const agentIconSchema = z
  .object({
    shape: z.enum(['circle', 'diamond', 'spark', 'flower', 'cloud']),
    color: z.enum(['blue', 'red', 'yellow', 'green']),
  })
  .strict();
export type AgentIcon = z.infer<typeof agentIconSchema>;

/** Reserved `customData` key under which the agent avatar is stored. */
export const AGENT_ICON_CUSTOM_DATA_KEY = 'icon';

const profileBaseSchema = z.object({
  id: trimmedString(255),
  alias: trimmedString(255),
  agentletId: trimmedString(255),
  workingDirPath: pathSchema,
  customData: customDataSchema.optional(),
});

const setupErrorSchema = z
  .object({
    code: trimmedString(255),
    message: z.string(),
  })
  .strict();

export const agentTeamPreparationSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('not_prepared') }).strict(),
  z
    .object({
      status: z.literal('setting_up'),
      operationId: trimmedString(255),
      startedAt: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      status: z.literal('ready'),
      completedAt: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      status: z.literal('error'),
      failedAt: z.number().int().nonnegative(),
      error: setupErrorSchema,
    })
    .strict(),
]);

export const agentTeamSetupLogEntrySchema = z
  .object({
    receivedAt: z.number().int().nonnegative(),
    phase: z.enum([
      'validating_manifest',
      'preparing_workspace',
      'installing_tools',
      'installing_skills',
      'placing_prompt',
      'copying_files',
      'running_custom_setup',
    ]),
    status: z.enum(['started', 'completed']),
    message: z.string(),
  })
  .strict();

const manifestLaunchSchema = z
  .object({
    kind: z.literal('agent-team-manifest'),
    manifestPath: pathSchema,
    harness: trimmedString(255),
  })
  .strict();

const commandLaunchSchema = z
  .object({
    kind: z.literal('acp-command'),
    command: trimmedString(65_536),
  })
  .strict();

const commandMetadataSchema = z
  .object({
    cliId: trimmedString(255).optional(),
  })
  .strict();

export const agentTeamManifestProfileSchema = profileBaseSchema
  .extend({
    launch: manifestLaunchSchema,
    preparation: agentTeamPreparationSchema,
  })
  .strict();
export type AgentTeamManifestProfileView = z.infer<
  typeof agentTeamManifestProfileSchema
>;

export const agentTeamManifestProfileDetailSchema =
  agentTeamManifestProfileSchema
    .extend({
      setupLog: z.array(agentTeamSetupLogEntrySchema),
    })
    .strict();
export type AgentTeamManifestProfileDetailView = z.infer<
  typeof agentTeamManifestProfileDetailSchema
>;

export const acpCommandProfileSchema = profileBaseSchema
  .extend({
    launch: commandLaunchSchema,
    metadata: commandMetadataSchema.optional(),
  })
  .strict();
export type AcpCommandProfileView = z.infer<typeof acpCommandProfileSchema>;

export const agentProfileSchema = z.union([
  agentTeamManifestProfileSchema,
  acpCommandProfileSchema,
]);
export type AgentProfileView = z.infer<typeof agentProfileSchema>;

export const createAgentProfileBodySchema = z.union([
  profileBaseSchema
    .omit({ id: true })
    .extend({ launch: manifestLaunchSchema })
    .strict(),
  profileBaseSchema
    .omit({ id: true })
    .extend({
      launch: commandLaunchSchema,
      metadata: commandMetadataSchema.optional(),
    })
    .strict(),
]);
export type CreateAgentProfileBody = z.infer<
  typeof createAgentProfileBodySchema
>;

const createAgentTeamProfileBaseSchema = profileBaseSchema
  .omit({ id: true, workingDirPath: true })
  .extend({ launch: manifestLaunchSchema });

export const createAgentTeamProfileBodySchema = z.union([
  createAgentTeamProfileBaseSchema
    .extend({
      workingDirectory: z.object({ kind: z.literal('default') }).strict(),
    })
    .strict(),
  createAgentTeamProfileBaseSchema
    .extend({
      workingDirectory: z
        .object({
          kind: z.literal('custom'),
          path: pathSchema,
        })
        .strict(),
    })
    .strict(),
]);
export type CreateAgentTeamProfileBody = z.infer<
  typeof createAgentTeamProfileBodySchema
>;

export const createAcpCommandProfileBodySchema = profileBaseSchema
  .omit({ id: true, agentletId: true })
  .extend({
    launch: commandLaunchSchema,
    metadata: commandMetadataSchema.optional(),
  })
  .strict();
export type CreateAcpCommandProfileBody = z.infer<
  typeof createAcpCommandProfileBodySchema
>;

export const patchAgentProfileBodySchema = z
  .object({
    alias: trimmedString(255).optional(),
    customData: customDataSchema.nullable().optional(),
    metadata: commandMetadataSchema.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one Profile field is required',
  });
export type PatchAgentProfileBody = z.infer<typeof patchAgentProfileBodySchema>;

export const agentProfileParamsSchema = z
  .object({ id: trimmedString(255) })
  .strict();
export type AgentProfileParams = z.infer<typeof agentProfileParamsSchema>;

export const agentProfileListSchema = z
  .object({
    profiles: z.array(agentProfileSchema),
  })
  .strict();
export type AgentProfileList = z.infer<typeof agentProfileListSchema>;
