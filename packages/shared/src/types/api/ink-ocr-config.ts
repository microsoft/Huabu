// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { z } from 'zod';

/** Azure AI Vision resource endpoint, not a generic OCR or LLM API URL. */
export const inkOcrEndpointSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !value.includes('?') &&
        !value.includes('#')
      );
    } catch {
      return false;
    }
  }, 'Use an HTTPS Azure AI Vision resource endpoint without credentials, query, or fragment');

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
