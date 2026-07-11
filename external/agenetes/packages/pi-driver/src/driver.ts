import {
  PI_DRIVER_CAPABILITIES,
  PiAgentHandle,
  type InStreamEvent,
  type PiTurnCtx,
} from './handle.js';

import type {
  PiDriverFactoryConfig,
  PiRenderedInput,
  PiRunResult,
  PiWorkloadSpec,
} from './types.js';
import type { AgentDriver } from '@agenetes/runtime';

export type { PiRenderedInput, PiRunResult, PiWorkloadSpec } from './types.js';

export type PiAgentDriver<TRequest = unknown> = AgentDriver<
  PiWorkloadSpec,
  TRequest,
  PiRenderedInput,
  PiRunResult,
  InStreamEvent,
  PiTurnCtx
>;

export function piDriverFactory<TRequest = unknown>(
  config: PiDriverFactoryConfig<TRequest>,
): PiAgentDriver<TRequest> {
  return {
    description:
      'Standard in-process pi-agent-core driver with Job and Deployment lifecycles; host policy enters through model, credential, and tool ports.',
    capabilities: PI_DRIVER_CAPABILITIES,
    create: (spec, context) =>
      new PiAgentHandle<TRequest>(spec, config.ports, context),
  };
}
