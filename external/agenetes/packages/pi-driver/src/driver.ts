import { defineDriver } from '@agenetes/runtime';

import { PiAgentHandle, type InStreamEvent, type PiTurnCtx } from './handle.js';
import {
  piDurableStateSchema,
  piSpecSchema,
  type PiDriverFactoryConfig,
  type PiDurableState,
  type PiRunResult,
  type PiSpec,
} from './types.js';

import type { AgentSubmission } from '@agenetes/protocol';
import type { AgentDriver, MountedAgentDriver } from '@agenetes/runtime';

export type { PiRunResult, PiWorkloadSpec } from './types.js';

export type PiAgentDriver<
  TSubmission extends AgentSubmission = AgentSubmission,
> = AgentDriver<
  PiSpec,
  PiDurableState,
  TSubmission,
  PiRunResult,
  InStreamEvent,
  PiTurnCtx
>;

export function piDriverFactory<
  TSubmission extends AgentSubmission = AgentSubmission,
>(config: PiDriverFactoryConfig): MountedAgentDriver {
  return defineDriver({
    schemaVersion: 1,
    workloadTypes: ['Job', 'Deployment'],
    specSchema: piSpecSchema,
    stateSchema: piDurableStateSchema,
    initialState: () => ({}),
    create: (spec, context) =>
      new PiAgentHandle<TSubmission>(spec, config.ports, context),
  });
}
