import { AgentTeamRegistry } from './registry.js';
import { FileAgentTeamRegistryStore } from './store.js';

import type { AgentTeamControlPort, AgentTeamSecretStore } from './types.js';

export interface CreateAgentTeamRegistryOptions {
  storageDir: string;
  controlPort: AgentTeamControlPort;
  secretStore: AgentTeamSecretStore;
  now?: () => number;
}

/** Create the production registry backed by Agenetes-owned files. */
export function createAgentTeamRegistry(
  options: CreateAgentTeamRegistryOptions,
): AgentTeamRegistry {
  return new AgentTeamRegistry(
    new FileAgentTeamRegistryStore(options.storageDir),
    options.controlPort,
    options.now,
    undefined,
    options.secretStore,
    options.controlPort,
  );
}
