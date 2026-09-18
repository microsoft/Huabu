import { AgentProfileRegistry } from './registry.js';
import {
  FileAgentProfileRegistryStore,
  InMemoryAgentProfileRegistryStore,
  readLegacyProfiles,
} from './store.js';

import type { CreateAcpCommandProfileInput } from './types.js';

export interface CreateAgentProfileRegistryOptions {
  storageDir: string;
  legacyStorageDir?: string;
  legacyCommandProfiles?: CreateAcpCommandProfileInput[];
}

/** Initialize once, including an empty registry, without modifying legacy files. */
export function createAgentProfileRegistry(
  options: CreateAgentProfileRegistryOptions,
): AgentProfileRegistry {
  const store = new FileAgentProfileRegistryStore(options.storageDir);
  if (!store.exists()) {
    const profiles = options.legacyStorageDir
      ? readLegacyProfiles(options.legacyStorageDir)
      : [];
    const imported = new AgentProfileRegistry(
      new InMemoryAgentProfileRegistryStore({ profiles }),
    );
    imported.importCommandProfiles(options.legacyCommandProfiles ?? []);
    store.save({ profiles: imported.listProfiles() });
  }
  return new AgentProfileRegistry(store);
}
