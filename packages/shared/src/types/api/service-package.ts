// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { z } from 'zod';

const serviceIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,63}$/, 'Invalid service id');
const serviceFieldIdSchema = z
  .string()
  .regex(/^[a-z][a-zA-Z0-9]{0,63}$/, 'Invalid service field id');

export const serviceFieldOptionSchema = z.object({
  value: z.string().min(1).max(256),
  label: z.string().min(1).max(256),
});

export const serviceConfigurationFieldSchema = z
  .object({
    id: serviceFieldIdSchema,
    label: z.string().min(1).max(256),
    description: z.string().max(1024).optional(),
    type: z.enum(['text', 'secret', 'url', 'boolean', 'enum']),
    required: z.boolean().default(false),
    options: z.array(serviceFieldOptionSchema).min(1).max(100).optional(),
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

export const serviceManifestSchema = z
  .object({
    schema: z.literal('huabu-service/v1'),
    id: serviceIdSchema,
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
    agent: z
      .object({
        skill: z.string().min(1).max(256),
        client: z.string().min(1).max(256).optional(),
      })
      .strict()
      .optional(),
    configuration: z
      .array(serviceConfigurationFieldSchema)
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
  });

export type ServiceManifest = z.infer<typeof serviceManifestSchema>;
export type ServiceConfigurationField = z.infer<
  typeof serviceConfigurationFieldSchema
>;

export const serviceFieldValueSchema = z.union([
  z.string().max(8192),
  z.boolean(),
  z.null(),
]);
export type ServiceFieldValue = z.infer<typeof serviceFieldValueSchema>;

export const serviceConfigUpdateSchema = z
  .object({
    values: z.record(serviceFieldIdSchema, serviceFieldValueSchema),
  })
  .strict()
  .refine((body) => Object.keys(body.values).length > 0, {
    message: 'Provide at least one service configuration value',
  });
export type ServiceConfigUpdate = z.infer<typeof serviceConfigUpdateSchema>;

export const serviceParamsSchema = z
  .object({ serviceId: serviceIdSchema })
  .strict();
export type ServiceParams = z.infer<typeof serviceParamsSchema>;

export const serviceConfigSchema = z
  .object({
    manifest: serviceManifestSchema,
    values: z.record(serviceFieldIdSchema, serviceFieldValueSchema),
    configuredFields: z.array(serviceFieldIdSchema),
    configured: z.boolean(),
  })
  .strict();
export type ServiceConfig = z.infer<typeof serviceConfigSchema>;

export const serviceSummarySchema = z
  .object({
    id: serviceIdSchema,
    version: z.string(),
    name: z.string(),
    description: z.string(),
    configured: z.boolean(),
    availableToExternalAgent: z.boolean(),
  })
  .strict();
export type ServiceSummary = z.infer<typeof serviceSummarySchema>;

export const serviceListResponseSchema = z
  .object({ services: z.array(serviceSummarySchema) })
  .strict();
export type ServiceListResponse = z.infer<typeof serviceListResponseSchema>;

export const serviceLeaseSchema = z
  .object({
    id: serviceIdSchema,
    version: z.string(),
    config: z.record(serviceFieldIdSchema, serviceFieldValueSchema),
    client: z.string().optional(),
  })
  .strict();
export type ServiceLease = z.infer<typeof serviceLeaseSchema>;
