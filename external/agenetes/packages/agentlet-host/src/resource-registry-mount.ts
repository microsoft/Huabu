import { createResourceRegistry } from '@agenetes/resource-registry';

import type { AgentResource } from '@agenetes/protocol';
import type { ResourceRegistry } from '@agenetes/resource-registry';
import type { FastifyInstance } from 'fastify';

export interface MountResourceRegistryOptions {
  storageDir: string;
  initialResources?: readonly AgentResource[];
  /** Providers whose supplied records are complete startup snapshots. */
  reconciledProviders?: readonly string[];
}

let instance: ResourceRegistry | null = null;
let configured = false;

/** Mount the durable Resource Registry and reconcile host-owned definitions. */
export function mountResourceRegistry(
  app: FastifyInstance,
  options: MountResourceRegistryOptions,
): void {
  if (configured) return;
  configured = true;

  app.addHook('onReady', async () => {
    instance = createResourceRegistry({ storageDir: options.storageDir });
    const byProvider = new Map<string, AgentResource[]>();
    for (const provider of options.reconciledProviders ?? []) {
      byProvider.set(provider, []);
    }
    for (const resource of options.initialResources ?? []) {
      const records = byProvider.get(resource.provider) ?? [];
      records.push(resource);
      byProvider.set(resource.provider, records);
    }
    for (const [provider, resources] of byProvider) {
      instance.replaceProviderResources(provider, resources);
    }
  });
  app.addHook('preClose', async () => {
    instance = null;
    configured = false;
  });
}

/** Return the mounted Resource Registry, if configured by the host. */
export function getResourceRegistry(): ResourceRegistry | null {
  return instance;
}
