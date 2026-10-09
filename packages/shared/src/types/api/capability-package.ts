// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { z } from 'zod';

const capabilityIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,63}$/, 'Invalid capability id');
const capabilityFieldIdSchema = z
  .string()
  .regex(/^[a-z][a-zA-Z0-9]{0,63}$/, 'Invalid capability field id');

export const capabilityFieldOptionSchema = z.object({
  value: z.string().min(1).max(256),
  label: z.string().min(1).max(256),
});

export const capabilityConfigurationFieldSchema = z
  .object({
    id: capabilityFieldIdSchema,
    label: z.string().min(1).max(256),
    description: z.string().max(1024).optional(),
    type: z.enum(['text', 'secret', 'url', 'boolean', 'enum']),
    required: z.boolean().default(false),
    options: z.array(capabilityFieldOptionSchema).min(1).max(100).optional(),
    placeholder: z.string().max(512).optional(),
  })
  .strict()
  .superRefine((field, ctx) => {
    if (field.type === 'enum' && !field.options) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'Enum fields require options',
      });
    }
    if (field.type !== 'enum' && field.options) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'Only enum fields may declare options',
      });
    }
  });

export const capabilityManifestSchema = z
  .object({
    schema: z.literal('huabu-capability/v1'),
    id: capabilityIdSchema,
    version: z.string().regex(/^\d+\.\d+\.\d+$/, 'Invalid package version'),
    name: z.string().min(1).max(256),
    description: z.string().min(1).max(1024),
    storage: z
      .object({
        namespace: z
          .string()
          .regex(/^[a-z][a-zA-Z0-9.]{0,127}$/, 'Invalid storage namespace'),
      })
      .strict(),
    consumers: z
      .object({
        internal: z.boolean().default(false),
        pipeline: z.boolean().default(false),
        external: z.boolean().default(false),
      })
      .strict(),
    agent: z
      .object({
        skill: z.string().min(1).max(256).optional(),
        client: z.string().min(1).max(256).optional(),
      })
      .strict()
      .optional(),
    configuration: z
      .array(capabilityConfigurationFieldSchema)
      .max(100)
      .default([]),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const ids = new Set<string>();
    for (const [index, field] of manifest.configuration.entries()) {
      if (ids.has(field.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['configuration', index, 'id'],
          message: `Duplicate configuration field: ${field.id}`,
        });
      }
      ids.add(field.id);
    }
    if (manifest.consumers.external && !manifest.agent?.skill) {
      ctx.addIssue({
        code: 'custom',
        path: ['agent', 'skill'],
        message: 'External capabilities require a Skill',
      });
    }
    if (!manifest.consumers.external && manifest.agent) {
      ctx.addIssue({
        code: 'custom',
        path: ['agent'],
        message: 'Only external capabilities may declare Agent files',
      });
    }
  });

export type CapabilityManifest = z.infer<typeof capabilityManifestSchema>;
export type CapabilityConfigurationField = z.infer<
  typeof capabilityConfigurationFieldSchema
>;

export const capabilityFieldValueSchema = z.union([
  z.string().max(8192),
  z.boolean(),
  z.null(),
]);
export type CapabilityFieldValue = z.infer<typeof capabilityFieldValueSchema>;

export const capabilityConfigUpdateSchema = z
  .object({
    values: z.record(capabilityFieldIdSchema, capabilityFieldValueSchema),
  })
  .strict()
  .refine((body) => Object.keys(body.values).length > 0, {
    message: 'Provide at least one capability configuration value',
  });
export type CapabilityConfigUpdate = z.infer<
  typeof capabilityConfigUpdateSchema
>;

export const capabilityParamsSchema = z
  .object({ capabilityId: capabilityIdSchema })
  .strict();
export type CapabilityParams = z.infer<typeof capabilityParamsSchema>;

export const capabilityConfigSchema = z
  .object({
    manifest: capabilityManifestSchema,
    values: z.record(capabilityFieldIdSchema, capabilityFieldValueSchema),
    configuredFields: z.array(capabilityFieldIdSchema),
    configured: z.boolean(),
  })
  .strict();
export type CapabilityConfig = z.infer<typeof capabilityConfigSchema>;

export const capabilitySummarySchema = z
  .object({
    id: capabilityIdSchema,
    version: z.string(),
    name: z.string(),
    description: z.string(),
    configured: z.boolean(),
    availableToInternalAgent: z.boolean(),
    availableToPipeline: z.boolean(),
    availableToExternalAgent: z.boolean(),
  })
  .strict();
export type CapabilitySummary = z.infer<typeof capabilitySummarySchema>;

export const capabilityListResponseSchema = z
  .object({ capabilities: z.array(capabilitySummarySchema) })
  .strict();
export type CapabilityListResponse = z.infer<
  typeof capabilityListResponseSchema
>;

export const capabilityLeaseSchema = z
  .object({
    id: capabilityIdSchema,
    version: z.string(),
    config: z.record(capabilityFieldIdSchema, capabilityFieldValueSchema),
    client: z.string().optional(),
  })
  .strict();
export type CapabilityLease = z.infer<typeof capabilityLeaseSchema>;
