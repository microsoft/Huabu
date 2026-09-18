import { createAgentProfileRegistry } from '@agenetes/agent-profile';

import type {
  AgentProfileRegistry,
  CreateAgentProfileRegistryOptions,
} from '@agenetes/agent-profile';
import type { FastifyInstance } from 'fastify';

export type MountAgentProfileOptions = CreateAgentProfileRegistryOptions;

let instance: AgentProfileRegistry | null = null;
let configured = false;

export function mountAgentProfileRegistry(
  app: FastifyInstance,
  options: MountAgentProfileOptions,
): void {
  if (configured) return;
  configured = true;
  app.addHook('onReady', async () => {
    instance = createAgentProfileRegistry(options);
  });
  app.addHook('preClose', async () => {
    instance?.dispose();
    instance = null;
    configured = false;
  });
}

export function getAgentProfileRegistry(): AgentProfileRegistry | null {
  return instance;
}
