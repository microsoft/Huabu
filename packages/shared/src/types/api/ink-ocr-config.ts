// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { z } from 'zod';

/** Direct Azure public-cloud resource or regional endpoint, without an API path. */
export const inkOcrEndpointSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .regex(
    /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:cognitiveservices\.azure\.com|api\.cognitive\.microsoft\.com)(?::443)?\/?$/i,
    'Use an HTTPS Azure public-cloud resource root endpoint under cognitiveservices.azure.com or api.cognitive.microsoft.com, without credentials, query, fragment, or a nondefault port',
  );

const configSourceSchema = z.enum(['stored', 'environment', 'none']);

export const inkOcrConfigSchema = z.object({
  provider: z.literal('azure-vision'),
  endpoint: inkOcrEndpointSchema.nullable(),
  endpointSource: configSourceSchema,
  keySource: configSourceSchema,
  hasStoredKey: z.boolean(),
  configured: z.boolean(),
});
export type InkOcrConfig = z.infer<typeof inkOcrConfigSchema>;

export const inkOcrConfigUpdateSchema = z
  .object({
    endpoint: inkOcrEndpointSchema.nullable().optional(),
    apiKey: z.string().trim().min(1).max(4096).nullable().optional(),
  })
  .strict()
  .refine(
    (value) => value.endpoint !== undefined || value.apiKey !== undefined,
    'Provide an endpoint or API key update',
  );
export type InkOcrConfigUpdate = z.infer<typeof inkOcrConfigUpdateSchema>;
