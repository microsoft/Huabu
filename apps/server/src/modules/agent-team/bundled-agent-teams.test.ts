// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it, vi } from 'vitest';

import {
  registerBundledAgentTeams,
  resolveBundledAgentTeamsPath,
} from './bundled-agent-teams.js';

import type { AgentTeamRegistry } from '@agenetes/agentlet-host';

function successfulScan(rootPath: string) {
  return {
    ok: true as const,
    root: {
      machine: 'local-machine',
      path: rootPath,
      scan: { status: 'success' as const, scannedAt: 1, diagnostics: [] },
    },
    members: [],
  };
}

describe('bundled Agent Teams', () => {
  it('resolves the checked-in collection during source development', () => {
    expect(resolveBundledAgentTeamsPath()).toMatch(/[\\/]agent-teams$/);
  });

  it('registers the bundled root after the local machine connects', async () => {
    const rootPath = '/resources/server/agent-teams';
    const addRoot = vi.fn(async () => successfulScan(rootPath));
    const removeRoot = vi.fn(() => true);
    let machines: Array<{ machine: string }> = [];
    let onMachinesChanged: (() => void) | undefined;
    const unsubscribe = vi.fn();

    const dispose = registerBundledAgentTeams({
      bundledRootPath: rootPath,
      localMachine: 'local-machine',
      machineSource: {
        listAgentTeamMachines: () => machines,
        onAgentTeamMachinesChanged: (handler) => {
          onMachinesChanged = handler;
          return unsubscribe;
        },
      },
      getRegistry: () =>
        ({
          addRoot,
          listRoots: () => [
            {
              machine: 'remote-machine',
              path: '/custom/teams',
              scan: { status: 'never_scanned' },
            },
          ],
          removeRoot,
        }) as unknown as Pick<
          AgentTeamRegistry,
          'addRoot' | 'listRoots' | 'removeRoot'
        >,
      log: { info: vi.fn(), warn: vi.fn() },
    });

    expect(addRoot).not.toHaveBeenCalled();
    machines = [{ machine: 'local-machine' }];
    onMachinesChanged?.();
    await vi.waitFor(() => expect(addRoot).toHaveBeenCalledOnce());
    expect(addRoot).toHaveBeenCalledWith({
      machine: 'local-machine',
      path: rootPath,
    });
    expect(removeRoot).toHaveBeenCalledWith({
      machine: 'remote-machine',
      path: '/custom/teams',
      scan: { status: 'never_scanned' },
    });

    dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('does not register the bundled root on a remote machine connection', () => {
    const addRoot = vi.fn();

    registerBundledAgentTeams({
      bundledRootPath: '/resources/server/agent-teams',
      localMachine: 'local-machine',
      machineSource: {
        listAgentTeamMachines: () => [{ machine: 'remote-machine' }],
        onAgentTeamMachinesChanged: () => vi.fn(),
      },
      getRegistry: () =>
        ({
          addRoot,
          listRoots: () => [],
          removeRoot: vi.fn(),
        }) as unknown as Pick<
          AgentTeamRegistry,
          'addRoot' | 'listRoots' | 'removeRoot'
        >,
      log: { info: vi.fn(), warn: vi.fn() },
    });

    expect(addRoot).not.toHaveBeenCalled();
  });
});
