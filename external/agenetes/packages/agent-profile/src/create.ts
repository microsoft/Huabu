import { AgentProfileRegistry } from './registry.js';
import {
  InMemoryAgentProfileRegistryStore,
  readLegacyProfiles,
} from './store.js';

import type { AgentProfileRegistryOptions } from './registry.js';
import type {
  AgentProfileRegistryStore,
  CreateAcpCommandProfileInput,
} from './types.js';

export interface CreateAgentProfileRegistryOptions {
  /** Where the registry persists; for example a `FileAgentProfileRegistryStore`. */
  store: AgentProfileRegistryStore;
  /** Host authorization, resolved once per registry read or mutation. */
  resolveAccess?: AgentProfileRegistryOptions['resolveAccess'];
  /** Directory of a legacy `registry.json` imported when `store` is empty. */
  legacyStorageDir?: string;
  legacyCommandProfiles?: CreateAcpCommandProfileInput[];
}

/**
 * Initialize once, including an empty registry, without modifying legacy
 * files. Reads the store once: the state it loads, or the state it seeds an
 * empty store with, is the state the registry opens on.
 */
export async function createAgentProfileRegistry(
  options: CreateAgentProfileRegistryOptions,
): Promise<AgentProfileRegistry> {
  const { store } = options;
  let state = await store.load();
  if (state === null) {
    const profiles = options.legacyStorageDir
      ? readLegacyProfiles(options.legacyStorageDir)
      : [];
    const imported = await AgentProfileRegistry.open(
      new InMemoryAgentProfileRegistryStore({ profiles }),
    );
    await imported.importCommandProfiles(options.legacyCommandProfiles ?? []);
    state = { profiles: await imported.listProfiles() };
    await store.save(state);
  }
  return AgentProfileRegistry.fromState(store, state, {
    resolveAccess: options.resolveAccess,
  });
}
