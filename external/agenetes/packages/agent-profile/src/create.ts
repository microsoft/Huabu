import { AgentProfileRegistry } from './registry.js';
import {
  InMemoryAgentProfileRegistryStore,
  readLegacyProfiles,
} from './store.js';

import type {
  AgentProfile,
  AgentProfileRegistryStore,
  CreateAcpCommandProfileInput,
} from './types.js';

export interface CreateAgentProfileRegistryOptions {
  /** Where the registry persists; for example a `FileAgentProfileRegistryStore`. */
  store: AgentProfileRegistryStore;
  /** Host authorization evaluated on every Profile read and mutation. */
  canAccess?: (profile: AgentProfile) => boolean;
  /** Directory of a legacy `registry.json` imported when `store` is empty. */
  legacyStorageDir?: string;
  legacyCommandProfiles?: CreateAcpCommandProfileInput[];
}

/** Initialize once, including an empty registry, without modifying legacy files. */
export async function createAgentProfileRegistry(
  options: CreateAgentProfileRegistryOptions,
): Promise<AgentProfileRegistry> {
  const { store } = options;
  if (store.load() === null) {
    const profiles = options.legacyStorageDir
      ? readLegacyProfiles(options.legacyStorageDir)
      : [];
    const imported = new AgentProfileRegistry(
      new InMemoryAgentProfileRegistryStore({ profiles }),
    );
    await imported.importCommandProfiles(options.legacyCommandProfiles ?? []);
    await store.save({ profiles: imported.listProfiles() });
  }
  return new AgentProfileRegistry(store, undefined, options.canAccess);
}
