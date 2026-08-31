import { agentResourceSchema } from '@agenetes/protocol';

import { ResourceRegistryError } from './errors.js';

import type { ResourceRegistryState, ResourceRegistryStore } from './types.js';
import type { AgentResource } from '@agenetes/protocol';

function cloneState(state: ResourceRegistryState): ResourceRegistryState {
  return structuredClone(state);
}

function cloneResource(resource: AgentResource): AgentResource {
  return structuredClone(resource);
}

/**
 * The framework-independent Agenetes Resource Registry (§6): list, look
 * up, register, replace, and withdraw `AgentResource` catalogue records.
 * Registration is a privileged provider operation — there is no
 * general resource-authoring API here, only the operations a provider
 * (Huabu, an Agentlet machine, ...) uses to publish and retract its own
 * records.
 */
export class ResourceRegistry {
  private state: ResourceRegistryState;

  constructor(private readonly store: ResourceRegistryStore) {
    const loaded = store.load();
    const resources = loaded.resources.map((resource) =>
      this.validateResource(resource),
    );
    if (new Set(resources.map(({ id }) => id)).size !== resources.length) {
      throw new ResourceRegistryError(
        'resource_conflict',
        'Resource Registry contains duplicate resource ids',
      );
    }
    this.state = { resources };
  }

  /**
   * The complete catalogue, sorted stably by `id` (§6: "list order is
   * stable by resource ID"). Safe to expose verbatim — records never carry
   * secrets (§12).
   */
  list(): AgentResource[] {
    return [...this.state.resources]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(cloneResource);
  }

  get(id: string): AgentResource | undefined {
    const resource = this.state.resources.find(
      (candidate) => candidate.id === id,
    );
    return resource ? cloneResource(resource) : undefined;
  }

  /**
   * Publishes a brand-new record. Fails with `resource_conflict` when the
   * ID is already registered — by this provider or any other — since
   * `register` is create-only; use {@link replaceOwn} to update an
   * existing record (§6: "Registration of an existing ID succeeds only as
   * an explicit replacement by the same provider").
   */
  register(resource: AgentResource): AgentResource {
    resource = this.validateResource(resource);
    if (
      this.state.resources.some((candidate) => candidate.id === resource.id)
    ) {
      throw new ResourceRegistryError(
        'resource_conflict',
        `Resource is already registered: ${resource.id}`,
      );
    }
    const next = cloneResource(resource);
    this.commit({
      resources: [...this.state.resources, next],
    });
    return cloneResource(next);
  }

  /**
   * Replaces an existing record in place. Requires `provider` to match
   * both the stored record's provider and the replacement's own `provider`
   * field — a different provider receives `resource_conflict` (§6). Fails
   * with `resource_not_found` when the ID is not yet registered.
   */
  replaceOwn(provider: string, resource: AgentResource): AgentResource {
    resource = this.validateResource(resource);
    this.requireOwned(provider, resource.id);
    if (resource.provider !== provider) {
      throw new ResourceRegistryError(
        'resource_conflict',
        `Resource provider cannot change on replace: ${resource.id}`,
      );
    }
    const next = cloneResource(resource);
    this.commit({
      resources: this.state.resources.map((candidate) =>
        candidate.id === resource.id ? next : candidate,
      ),
    });
    return cloneResource(next);
  }

  /**
   * Atomically reconcile one provider's complete catalogue projection.
   * Records omitted from the replacement are withdrawn; other providers'
   * records remain untouched.
   */
  replaceProviderResources(
    provider: string,
    resources: readonly AgentResource[],
  ): AgentResource[] {
    const nextOwn = resources.map((resource) =>
      this.validateResource(resource),
    );
    if (nextOwn.some((resource) => resource.provider !== provider)) {
      throw new ResourceRegistryError(
        'resource_conflict',
        'Every replacement resource must belong to the provider',
      );
    }
    const nextIds = new Set(nextOwn.map(({ id }) => id));
    if (nextIds.size !== nextOwn.length) {
      throw new ResourceRegistryError(
        'resource_conflict',
        'Provider replacement contains duplicate resource ids',
      );
    }
    const otherResources = this.state.resources.filter(
      (resource) => resource.provider !== provider,
    );
    if (otherResources.some((resource) => nextIds.has(resource.id))) {
      throw new ResourceRegistryError(
        'resource_conflict',
        'Provider replacement conflicts with another provider',
      );
    }
    this.commit({ resources: [...otherResources, ...nextOwn] });
    return nextOwn.map(cloneResource);
  }

  /**
   * Retracts a record. Withdrawing does not cascade into any Profile that
   * still references the ID (§6) — a Profile may temporarily retain an
   * unresolved resource ID; realization surfaces that explicitly instead of
   * the catalogue silently repairing it.
   */
  withdraw(provider: string, id: string): void {
    this.requireOwned(provider, id);
    this.commit({
      resources: this.state.resources.filter(
        (candidate) => candidate.id !== id,
      ),
    });
  }

  private requireOwned(provider: string, id: string): AgentResource {
    const current = this.state.resources.find(
      (candidate) => candidate.id === id,
    );
    if (!current) {
      throw new ResourceRegistryError(
        'resource_not_found',
        `Resource not found: ${id}`,
      );
    }

    if (current.provider !== provider) {
      throw new ResourceRegistryError(
        'resource_conflict',
        `Resource is owned by a different provider: ${id}`,
      );
    }
    return current;
  }

  private validateResource(resource: AgentResource): AgentResource {
    const parsed = agentResourceSchema.safeParse(resource);
    if (!parsed.success) {
      throw new ResourceRegistryError(
        'invalid_resource',
        'Resource is not a valid AgentResource record',
      );
    }
    return parsed.data;
  }

  private commit(nextState: ResourceRegistryState): void {
    this.store.save(nextState);
    this.state = cloneState(nextState);
  }
}
