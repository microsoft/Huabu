import type { AgentResource } from '@agenetes/protocol';

/**
 * The full set of catalogue records, keyed by nothing but their own `id`
 * (§6: resource IDs are unique across the registry). Persistence-agnostic —
 * an {@link ResourceRegistryStore} implementation owns turning this into
 * bytes on disk, in memory, or anywhere else.
 */
export interface ResourceRegistryState {
  resources: AgentResource[];
}

/**
 * Framework-independent persistence port for the Resource Registry state.
 * Mirrors the existing `AgentTeamRegistryStore` shape (load/save a whole
 * state snapshot) so a host can compose both registries the same way.
 */
export interface ResourceRegistryStore {
  load(): ResourceRegistryState;
  save(state: ResourceRegistryState): void;
}
