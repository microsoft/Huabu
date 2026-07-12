import { PiAgentHandle, type InStreamEvent, type PiTurnCtx } from './handle.js';

import type {
  PiDriverFactoryConfig,
  PiRunResult,
  PiWorkloadSpec,
} from './types.js';
import type { AgentSubmission } from '@agenetes/protocol';
import type { AgentDriver } from '@agenetes/runtime';

export type { PiRunResult, PiWorkloadSpec } from './types.js';

export type PiAgentDriver<
  TSubmission extends AgentSubmission = AgentSubmission,
> = AgentDriver<
  PiWorkloadSpec,
  TSubmission,
  PiRunResult,
  InStreamEvent,
  PiTurnCtx
>;

export function piDriverFactory<
  TSubmission extends AgentSubmission = AgentSubmission,
>(config: PiDriverFactoryConfig): PiAgentDriver<TSubmission> {
  return {
    create: (spec, context) =>
      new PiAgentHandle<TSubmission>(spec, config.ports, context),
  };
}
