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
    schemaVersion: 1,
    id: 'huabu-access',
    name: 'Huabu Access',
    provider: 'huabu',
    description: 'Read and update the active Huabu Space through RFS.',
    instructions:
      'Fetch $HUABU_RFS_URL/skill with Authorization: Bearer $AGENTLET_TOKEN and follow the returned guide.',
  },
  {
    schemaVersion: 1,
    id: 'local-resource-management',
    name: 'Local Resource Management',
    provider: 'huabu',
    description:
      'Safely install and manage machine-local Skills, tools, and connectors.',
    instructions:
      'Fetch $HUABU_RFS_URL/skill/local-resource-management with Authorization: Bearer $AGENTLET_TOKEN before changing local resources.',
  },
  {
    schemaVersion: 1,
    id: 'web-search',
    name: 'Web Search',
    provider: 'huabu',
    description: 'Search the web through Huabu-managed provider credentials.',
    instructions:
      'POST {"schemaVersion":1,"input":{"query":"..."}} to $HUABU_RFS_URL/resources/web-search/invoke with Authorization: Bearer $AGENTLET_TOKEN and X-Huabu-Resource-Grant: $HUABU_RESOURCE_GRANT.',
  },
  {
    schemaVersion: 1,
    id: 'generate-image',
    name: 'Generate Image',
    provider: 'huabu',
    description:
      'Generate an image through Huabu and store it in the active Space.',
    instructions:
      'POST {"schemaVersion":1,"input":{"prompt":"..."}} to $HUABU_RFS_URL/resources/generate-image/invoke with Authorization: Bearer $AGENTLET_TOKEN and X-Huabu-Resource-Grant: $HUABU_RESOURCE_GRANT.',
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
