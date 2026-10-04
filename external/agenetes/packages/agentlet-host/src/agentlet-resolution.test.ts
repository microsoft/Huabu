import { describe, expect, it } from 'vitest';

import { resolveConnectedAgentletIdFromConnections } from './agentlet-resolution.js';

import type { AgentletConnection } from '@agenetes/agentlet-gateway';

function connection(
  agentletId: string,
  hostname: string,
  status: 'connected' | 'disconnected' = 'connected',
): AgentletConnection {
  return {
    agentletId,
    status,
    connectedAt: new Date(),
    agentletProfile: {
      bridge: { name: 'agentlet', version: '1.0.0' },
      machine: { hostname, platform: 'linux', arch: 'x64' },
      capabilities: { autoRestart: true, bufferLimit: 1000 },
    },
  } as AgentletConnection;
}

describe('resolveConnectedAgentletIdFromConnections', () => {
  it('prefers an exact connected identity over hostname compatibility', () => {
    expect(
      resolveConnectedAgentletIdFromConnections('device-a', [
        connection('device-a', 'other-host'),
        connection('device-b', 'device-a'),
      ]),
    ).toBe('device-a');
  });

  it('resolves one connected legacy hostname to its current identity', () => {
    expect(
      resolveConnectedAgentletIdFromConnections('legacy-host', [
        connection('device-a', 'legacy-host'),
      ]),
    ).toBe('device-a');
  });

  it('does not resolve absent or ambiguous legacy hostnames', () => {
    const devices = [
      connection('device-a', 'shared-host'),
      connection('device-b', 'shared-host'),
      connection('device-c', 'offline-host', 'disconnected'),
    ];

    expect(
      resolveConnectedAgentletIdFromConnections('missing-host', devices),
    ).toBeUndefined();
    expect(
      resolveConnectedAgentletIdFromConnections('shared-host', devices),
    ).toBeUndefined();
    expect(
      resolveConnectedAgentletIdFromConnections('offline-host', devices),
    ).toBeUndefined();
  });
});
