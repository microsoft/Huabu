// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { z } from 'zod';

export const agentDefaultsSchema = z
  .object({
    profileId: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine((value) => value !== 'huabu', 'Select an external Agent Profile')
      .nullable(),
    functionalModel: z.string().trim().max(500).default(''),
  })
  .strict();

export type AgentDefaults = z.infer<typeof agentDefaultsSchema>;

export const agentDefaultsResponseSchema = z.object({
  defaults: agentDefaultsSchema,
  selectionState: z.enum(['unconfigured', 'deleted', 'offline', 'available']),
  modelCapability: z.enum(['unknown', 'supported', 'unsupported']),
});

export type AgentDefaultsResponse = z.infer<typeof agentDefaultsResponseSchema>;
