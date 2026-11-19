// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { IdentityService } from './service.js';

const gateway = vi.hoisted(() => ({
  agentlets: [] as Array<{
    agentletId: string;
    metadata: Record<string, unknown>;
    disconnect: () => void;
  }>,
}));

vi.mock('@agenetes/agentlet-host', () => ({
  getAgentletGateway: () => ({
    getSessions: () => [],
    getAgentlets: () => gateway.agentlets,
  }),
}));

const { authenticateUserAgentlet, disconnectAgentlets, ownDeviceCredential } =
  await import('./agent-credentials.js');
const { openPersonalSettings, useCaller } =
  await import('./personal-settings.js');

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'huabu-reset-'));
  vi.stubEnv('HUABU_DATA_DIR', dataDir);
  writeFileSync(
    join(dataDir, 'agentlet-owners.json'),
    JSON.stringify({ 'alice-device': 'alice', 'bob-device': 'bob' }),
  );
  gateway.agentlets = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
});

it('disconnects a device whose admitted handshake registers just after a revocation', async () => {
  vi.stubEnv('HUABU_CONNECTION_TOKEN', 'test-host-credential');
  const alice = {
    member: true,
    principal: { principalId: 'alice' },
    access: null,
  } as never;
  const service = {
    provider: 'bubble',
    resolvePrincipal: async () => alice,
  } as unknown as IdentityService;
  const token = await openPersonalSettings(async () => {
    useCaller(alice);
    return ownDeviceCredential();
  });
  const bob = {
    agentletId: 'bob-device',
    metadata: { principalId: 'bob' },
    disconnect: vi.fn(),
  };
  const late = {
    agentletId: 'alice-device',
    metadata: { principalId: 'alice' },
    disconnect: vi.fn(),
  };
  gateway.agentlets = [bob];

  // The Gateway registers what an admission decided right after it
  // resolves. Land the revocation in between: after the decision, before
  // the connection is registered, where its own sweep cannot see it.
  await authenticateUserAgentlet(service)('alice-device', token).then(() => {
    disconnectAgentlets('alice', 'Device owner is not admitted');
    gateway.agentlets = [late, bob];
  });
  expect(late.disconnect).not.toHaveBeenCalled();
  await new Promise((resolve) => setImmediate(resolve));
  expect(late.disconnect).toHaveBeenCalledOnce();
  expect(bob.disconnect).not.toHaveBeenCalled();
});
