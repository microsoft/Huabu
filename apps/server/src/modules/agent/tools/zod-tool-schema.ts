// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Type, type Tool } from '@earendil-works/pi-ai';
import { z } from 'zod';

/**
 * Convert a canonical Zod contract into the TypeBox-compatible JSON Schema
 * shape consumed by pi-ai's tool validator.
 */
export function zodToToolSchema(schema: z.ZodType): Tool['parameters'] {
  const jsonSchema = z.toJSONSchema(schema, {
    target: 'draft-7',
    reused: 'inline',
  });
  delete jsonSchema.$schema;
  return Type.Unsafe(jsonSchema);
}
