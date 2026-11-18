// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

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

const { resetAgentCredentials } = await import('./agent-credentials.js');

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

it('disconnects a device whose admitted handshake registers just after a reset', async () => {
  // A connection carries the owner its handshake admitted it for.
  const alice = { principalId: 'alice' };
  const live = {
    agentletId: 'alice-device',
    metadata: alice,
    disconnect: vi.fn(),
  };
  const late = {
    agentletId: 'alice-device',
    metadata: alice,
    disconnect: vi.fn(),
  };
  const bob = {
    agentletId: 'bob-device',
    metadata: { principalId: 'bob' },
    disconnect: vi.fn(),
  };
  gateway.agentlets = [live, bob];

  await resetAgentCredentials('alice');
  expect(live.disconnect).toHaveBeenCalledOnce();
  // The Gateway registers a handshake authenticated before the reset only
  // once its authentication resolves, which is after the first sweep.
  await Promise.resolve();
  gateway.agentlets = [late, bob];
  expect(late.disconnect).not.toHaveBeenCalled();

  await new Promise((resolve) => setImmediate(resolve));
  expect(late.disconnect).toHaveBeenCalledOnce();
  expect(bob.disconnect).not.toHaveBeenCalled();
});
