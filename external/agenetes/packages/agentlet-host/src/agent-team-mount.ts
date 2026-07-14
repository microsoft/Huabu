import { createAgentTeamRegistry } from '@agenetes/agent-team';

import type {
  AgentTeamControlPort,
  AgentTeamRegistry,
  AgentTeamSecretStore,
} from '@agenetes/agent-team';
import type { FastifyInstance } from 'fastify';

export interface MountAgentTeamOptions {
  storageDir: string;
  secretStore: AgentTeamSecretStore;
}

let instance: AgentTeamRegistry | null = null;
let configured = false;

/** Configure the durable Agent Team control plane against the existing Gateway. */
export function mountAgentTeamRegistry(
  app: FastifyInstance,
  options: MountAgentTeamOptions,
  controlPort: AgentTeamControlPort,
): void {
  if (configured) return;
  configured = true;

  app.addHook('onReady', async () => {
    instance = createAgentTeamRegistry({
      storageDir: options.storageDir,
      secretStore: options.secretStore,
      controlPort,
    });
  });
  app.addHook('preClose', async () => {
    instance?.dispose();
    instance = null;
    configured = false;
  });
}

/** Return the mounted Agent Team control plane, if configured by the host. */
export function getAgentTeamRegistry(): AgentTeamRegistry | null {
  return instance;
}
