// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { agentletOwner } from '../../identity/agent-credentials.js';
import { getWorkspaceRepository, openWorkspace } from '../../storage/index.js';
import { runInWorkspace } from '../../workspace/context.js';
import { canvasAcpNamespace } from '../../workspace/paths.js';
import { agenetes, EXTERNAL_DRIVER_KIND } from '../agenetes/drivers.js';

import type { AgentReachback } from '../../identity/agent-credentials.js';

/**
 * Whether a reachback credential still names a live conversation: an external
 * agent's in that Space, on a device its owner still owns. Deleting the
 * conversation ends the credential, and open RFS streams close at their next
 * revalidation.
 */
export async function isCurrentReachback(
  claims: AgentReachback,
): Promise<boolean> {
  const workspace = await getWorkspaceRepository().get(claims.workspaceId);
  if (!workspace) return false;
  return runInWorkspace(await openWorkspace(workspace), async () => {
    const record = await agenetes.record(
      canvasAcpNamespace(claims.canvasId),
      claims.threadId,
    );
    if (record?.spec.kind !== EXTERNAL_DRIVER_KIND) return false;
    const { agentletId } = record.spec.spec as { agentletId?: unknown };
    return (
      typeof agentletId === 'string' &&
      agentletOwner(agentletId) === claims.principalId
    );
  });
}
