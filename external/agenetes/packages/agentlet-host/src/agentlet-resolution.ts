import { getAgentletGateway } from './gateway-mount.js';

import type { AgentletConnection } from '@agenetes/agentlet-gateway';

type ConnectedAgentlet = Pick<
  AgentletConnection,
  'agentletId' | 'agentletProfile' | 'status'
>;

let canAccess: (agentletId: string, requestedId: string) => boolean = () =>
  true;

/** Host authorization also applies to legacy hostname-based placement. */
export function setAgentletAccessPolicy(
  policy?: (agentletId: string, requestedId: string) => boolean,
): void {
  canAccess = policy ?? (() => true);
}

export function resolveConnectedAgentletIdFromConnections(
  target: string,
  connections: readonly ConnectedAgentlet[],
): string | undefined {
  const connected = connections.filter(
    (connection) => connection.status === 'connected',
  );
  const exact = connected.find(
    (connection) => connection.agentletId === target,
  );
  if (exact) return exact.agentletId;

  const hostnameMatches = connected.filter(
    (connection) => connection.agentletProfile?.machine?.hostname === target,
  );
  return hostnameMatches.length === 1
    ? hostnameMatches[0]?.agentletId
    : undefined;
}

export function resolveConnectedAgentletId(target: string): string | undefined {
  return resolveConnectedAgentletIdFromConnections(
    target,
    (getAgentletGateway()?.getAgentlets({ status: 'connected' }) ?? []).filter(
      (connection) => canAccess(connection.agentletId, target),
    ),
  );
}
