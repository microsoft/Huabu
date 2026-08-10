import {
  agentSpecSchema,
  sessionIdSchema,
  type AgentSubmission,
} from '@agenetes/protocol';
import { defineDriver } from '@agenetes/runtime';
import { z } from 'zod';

import { acpBindingRecipeSchema } from './binding-recipe.js';
import {
  AcpAgentHandle,
  type AcpDurableState,
  type AcpRuntimePolicy,
  type AcpSpec,
  type AcpTurnCtx,
  type InStreamEvent,
} from './handle.js';

import type { AcpBindingRecipe } from './binding-recipe.js';
import type { AgentDriver, MountedAgentDriver } from '@agenetes/runtime';

export type { AcpCreateSpec, AcpDurableState, AcpSpec } from './handle.js';

export type AcpAgentDriver<
  TSubmission extends AgentSubmission = AgentSubmission,
> = AgentDriver<
  AcpSpec,
  AcpDurableState,
  TSubmission,
  void,
  InStreamEvent,
  AcpTurnCtx
>;

export type AcpDriverFactoryConfig = AcpRuntimePolicy | undefined;

const DEFAULT_RUNTIME_POLICY: AcpRuntimePolicy = {
  getIdleTimeoutSecs: () => 600,
};

const recipeResolverSchema = z.custom<
  () => Promise<{ recipe: AcpBindingRecipe; env?: Record<string, string> }>
>((value) => typeof value === 'function', 'Invalid ACP recipe resolver');

export const acpSpecSchema = agentSpecSchema.extend({
  initialPreferences: z
    .object({
      model: z.string().optional(),
      thoughtLevel: z.string().optional(),
    })
    .strict()
    .optional(),
  binding: z.object({
    alias: z.string(),
    profileId: z.string(),
  }),
  agentletId: z.string().optional(),
  cwd: z.string().optional(),
  recipe: acpBindingRecipeSchema.nullable().optional(),
  resolveRecipe: recipeResolverSchema.optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export const acpDurableStateSchema = z.object({
  sessionId: sessionIdSchema.optional(),
  initialPreambleDelivered: z.boolean(),
});

export function acpDriverFactory<
  TSubmission extends AgentSubmission = AgentSubmission,
>(config: AcpDriverFactoryConfig = DEFAULT_RUNTIME_POLICY): MountedAgentDriver {
  return defineDriver({
    schemaVersion: 1,
    workloadTypes: ['Deployment'],
    specSchema: acpSpecSchema,
    stateSchema: acpDurableStateSchema,
    initialState: () => ({ initialPreambleDelivered: false }),
    create: (spec, context) =>
      new AcpAgentHandle<TSubmission>(spec, context, config),
  });
}
