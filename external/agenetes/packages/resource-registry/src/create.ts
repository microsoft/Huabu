import { ResourceRegistry } from './registry.js';
import { FileResourceRegistryStore } from './store.js';

export interface CreateResourceRegistryOptions {
  storageDir: string;
}

/** Create the production Resource Registry backed by Agenetes-owned files. */
export function createResourceRegistry(
  options: CreateResourceRegistryOptions,
): ResourceRegistry {
  return new ResourceRegistry(
    new FileResourceRegistryStore(options.storageDir),
  );
}
