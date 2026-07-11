import { PiAgentHandle, type InStreamEvent, type PiTurnCtx } from './handle.js';

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
    create: (spec, context) =>
      new PiAgentHandle<TRequest>(spec, config.ports, context),
  };
}
