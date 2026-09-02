import {
  AgentTeamError,
  getResourceRegistry,
  getSupervisedAgentletId,
} from '@agenetes/agentlet-host';
import {
  enumerateLocalResources,
  resolveResourceRoot,
} from '@agentlet/resources';

import { HUABU_REQUIRED_RESOURCE_IDS } from '@huabu/shared';

import type {
  AgentResource,
  AgentResourceValidationPort,
} from '@agenetes/agentlet-host';

export class ResourceRegistryUnavailableError extends Error {
  constructor() {
    super('Agent Resource Registry is not ready');
    this.name = 'ResourceRegistryUnavailableError';
  }
}

export const HUABU_RESOURCES: readonly AgentResource[] = [
  {
    schemaVersion: 2,
    id: 'huabu-access',
    name: 'Huabu Access',
    provider: 'huabu',
    sourceContent:
      'Read and update the active Huabu Space through RFS. Fetch $HUABU_RFS_URL/skill with the injected Agentlet token and follow the returned guide.',
    userContent: '',
  },
  {
    schemaVersion: 2,
    id: 'local-resource-management',
    name: 'Local Resource Management',
    provider: 'huabu',
    sourceContent:
      'Safely install and manage machine-local Skills, tools, and connectors. Fetch $HUABU_RFS_URL/skill/local-resource-management with the injected Agentlet token before changing local resources.',
    userContent: '',
  },
  {
    schemaVersion: 2,
    id: 'web-search',
    name: 'Web Search',
    provider: 'huabu',
    sourceContent:
      'Search the web through Huabu-managed provider credentials. POST {"schemaVersion":1,"input":{"query":"..."}} to $HUABU_RFS_URL/resources/web-search/invoke with the injected Agentlet token and X-Huabu-Resource-Grant: $HUABU_RESOURCE_GRANT.',
    userContent: '',
  },
  {
    schemaVersion: 2,
    id: 'generate-image',
    name: 'Generate Image',
    provider: 'huabu',
    sourceContent:
      'Generate an image through Huabu and store it in the active Space. POST {"schemaVersion":1,"input":{"prompt":"..."}} to $HUABU_RFS_URL/resources/generate-image/invoke with the injected Agentlet token and X-Huabu-Resource-Grant: $HUABU_RESOURCE_GRANT.',
    userContent: '',
  },
];

export const huabuResourceValidationPort: AgentResourceValidationPort = {
  validateResourceIds(resourceIds, context): void {
    const registry = getResourceRegistry();
    if (!registry) {
      throw new ResourceRegistryUnavailableError();
    }
    for (const id of resourceIds) {
      const resource = registry.get(id);
      if (!resource) {
        throw new AgentTeamError(
          'invalid_resource_ids',
          `Unknown Agent Resource: ${id}`,
        );
      }
      if (
        resource.provider !== 'huabu' &&
        resource.provider !== context.agentletId
      ) {
        throw new AgentTeamError(
          'invalid_resource_ids',
          `Agent Resource is not available on ${context.agentletId}: ${id}`,
        );
      }
    }
  },
};

export function resolveEffectiveResourceIds(
  selectedResourceIds: readonly string[],
  agentletId: string,
): string[] {
  const effective = [
    ...new Set([...HUABU_REQUIRED_RESOURCE_IDS, ...selectedResourceIds]),
  ];
  huabuResourceValidationPort.validateResourceIds(effective, { agentletId });
  return effective;
}

export function listResourcesForAgentlet(agentletId: string): AgentResource[] {
  const registry = getResourceRegistry();
  if (!registry) {
    throw new ResourceRegistryUnavailableError();
  }
  return registry
    .list()
    .filter(
      (resource) =>
        resource.provider === 'huabu' || resource.provider === agentletId,
    );
}

export function refreshLocalAgentResources(): ReturnType<
  typeof enumerateLocalResources
> {
  const registry = getResourceRegistry();
  if (!registry) {
    throw new ResourceRegistryUnavailableError();
  }
  const agentletId = getSupervisedAgentletId();
  const localResources = enumerateLocalResources(
    resolveResourceRoot(),
    agentletId,
  );
  registry.replaceProviderResources(agentletId, localResources.records);
  return localResources;
}

export function assertLocalResourceIdAvailable(
  resourceId: string,
  agentletId: string,
): void {
  const registry = getResourceRegistry();
  if (!registry) {
    throw new ResourceRegistryUnavailableError();
  }
  const existing = registry.get(resourceId);
  if (existing && existing.provider !== agentletId) {
    throw new AgentTeamError(
      'invalid_resource_ids',
      `Agent Resource ID is already owned by ${existing.provider}: ${resourceId}`,
    );
  }
}
