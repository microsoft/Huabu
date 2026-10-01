// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { z } from 'zod';

export const agentDefaultsSchema = z
  .object({
    profileId: z.string().trim().min(1).max(255).nullable(),
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

export const conversationAgentPreferenceSchema = z
  .object({
    profileId: z.string().trim().min(1).max(255).nullable(),
  })
  .strict();

export type ConversationAgentPreference = z.infer<
  typeof conversationAgentPreferenceSchema
>;

export const conversationAgentPreferenceResponseSchema = z.object({
  preference: conversationAgentPreferenceSchema,
  effectiveProfileId: z.string().min(1).max(255).nullable(),
  selectionState: z.enum(['unconfigured', 'deleted', 'offline', 'available']),
});

export type ConversationAgentPreferenceResponse = z.infer<
  typeof conversationAgentPreferenceResponseSchema
>;
