import { AgentTeamRegistry } from './registry.js';
import { FileAgentTeamRegistryStore } from './store.js';

import type { AgentTeamScanPort, AgentTeamSecretStore } from './types.js';

export interface CreateAgentTeamRegistryOptions {
  storageDir: string;
  scanPort: AgentTeamScanPort;
  secretStore: AgentTeamSecretStore;
  now?: () => number;
}

/** Create the production registry backed by Agenetes-owned files. */
export function createAgentTeamRegistry(
  options: CreateAgentTeamRegistryOptions,
): AgentTeamRegistry {
  return new AgentTeamRegistry(
    new FileAgentTeamRegistryStore(options.storageDir),
    options.scanPort,
    options.now,
    undefined,
    options.secretStore,
  );
}
