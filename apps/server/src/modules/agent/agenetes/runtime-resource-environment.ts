import { issueResourceGrant } from '../hosted-capabilities/resource-grant.js';

import type { AcpSpec } from '@agenetes/acp-driver';

export function resolveResourceGrantEnvironment(
  spec: AcpSpec,
): Record<string, string> | undefined {
  if (!spec.resourceScope || !spec.agentletId) {
    return undefined;
  }
  return issueResourceGrant({
    agentletId: spec.agentletId,
    profileId: spec.binding.profileId,
    canvasId: spec.resourceScope.canvasId,
    threadId: spec.resourceScope.threadId,
    allowedResourceIds: spec.resourceIds ?? [],
  });
}
