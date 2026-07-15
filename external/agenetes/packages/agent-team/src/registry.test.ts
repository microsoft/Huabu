import { describe, expect, it, vi } from 'vitest';

import { AgentTeamRegistry } from './registry.js';
import { InMemoryAgentTeamRegistryStore } from './store.js';

import type { AgentTeamScanPort, AgentTeamRootRef } from './types.js';
import type { AgentTeamScanResult } from '@agentlet/protocol';

const machine = 'machine-a';
const member = {
  name: 'reviewer',
  manifestPath: '/teams/reviewer/agentlet.yaml',
  description: 'Reviews changes',
  harnesses: ['copilot'],
  env: [],
};

class FakeScanPort implements AgentTeamScanPort {
  readonly results = new Map<string, AgentTeamScanResult | Error>();

  async scanAgentTeams(
    selectedMachine: string,
    params: { rootPath: string },
  ): Promise<AgentTeamScanResult> {
    const result = this.results.get(
      JSON.stringify([selectedMachine, params.rootPath]),
    );
    if (result instanceof Error) throw result;
    if (!result) throw new Error('No fake scan result');
    return structuredClone(result);
  }
}

function setResult(
  port: FakeScanPort,
  root: AgentTeamRootRef,
  result: Omit<AgentTeamScanResult, 'rootPath'> | Error,
): void {
  port.results.set(
    JSON.stringify([root.machine, root.path]),
    result instanceof Error ? result : { rootPath: root.path, ...result },
  );
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

describe('AgentTeamRegistry', () => {
  it('deduplicates members across roots and retains missing members', async () => {
    const first = { machine, path: '/collections/one' };
    const second = { machine, path: '/collections/two' };
    const port = new FakeScanPort();
    setResult(port, first, { members: [member], diagnostics: [] });
    setResult(port, second, { members: [member], diagnostics: [] });
    const registry = new AgentTeamRegistry(
      new InMemoryAgentTeamRegistryStore(),
      port,
      () => 100,
    );

    await registry.addRoot(first);
    await registry.addRoot(second);

    expect(registry.listMembers()).toEqual([
      expect.objectContaining({
        machine,
        manifestPath: member.manifestPath,
        status: 'active',
        discoveredBy: [first, second],
      }),
    ]);

    expect(registry.removeRoot(first)).toBe(true);
    expect(registry.listMembers()[0]).toMatchObject({
      status: 'active',
      discoveredBy: [second],
    });

    expect(registry.removeRoot(second)).toBe(true);
    expect(registry.listMembers()[0]).toMatchObject({
      name: 'reviewer',
      status: 'member_missing',
      discoveredBy: [],
    });
  });

  it('preserves discovery provenance when a rescan fails', async () => {
    const root = { machine, path: '/collections/one' };
    const port = new FakeScanPort();
    setResult(port, root, { members: [member], diagnostics: [] });
    const store = new InMemoryAgentTeamRegistryStore();
    const registry = new AgentTeamRegistry(store, port, () => 100);
    await registry.addRoot(root);

    setResult(port, root, new Error('daemon disconnected'));
    const result = await registry.rescanRoot(root);

    expect(result).toEqual({
      ok: false,
      root: {
        ...root,
        scan: {
          status: 'error',
          attemptedAt: 100,
          message: 'daemon disconnected',
        },
      },
      error: 'daemon disconnected',
    });
    expect(registry.listMembers()[0]).toMatchObject({
      status: 'active',
      discoveredBy: [root],
    });
  });

  it('persists partial scan diagnostics with valid members', async () => {
    const root = { machine, path: '/collections/one' };
    const port = new FakeScanPort();
    setResult(port, root, {
      members: [member],
      diagnostics: [
        {
          manifestPath: '/collections/one/broken/agentlet.yaml',
          code: 'invalid_manifest',
          message: 'Missing command',
        },
      ],
    });
    const registry = new AgentTeamRegistry(
      new InMemoryAgentTeamRegistryStore(),
      port,
      () => 200,
    );

    await registry.addRoot(root);

    expect(registry.listRoots()[0]?.scan).toEqual({
      status: 'success',
      scannedAt: 200,
      diagnostics: [
        expect.objectContaining({
          code: 'invalid_manifest',
          message: 'Missing command',
        }),
      ],
    });
    expect(registry.listMembers()).toHaveLength(1);
  });

  it('coalesces concurrent rescans of the same root', async () => {
    const root = { machine, path: '/collections/one' };
    const pending = deferred<AgentTeamScanResult>();
    const scanAgentTeams = vi.fn(() => pending.promise);
    const registry = new AgentTeamRegistry(
      new InMemoryAgentTeamRegistryStore(),
      { scanAgentTeams },
    );

    const first = registry.addRoot(root);
    const second = registry.rescanRoot(root);
    expect(scanAgentTeams).toHaveBeenCalledOnce();

    pending.resolve({
      rootPath: root.path,
      members: [member],
      diagnostics: [],
    });

    await expect(first).resolves.toEqual(await second);
    expect(registry.listMembers()[0]?.status).toBe('active');
  });

  it('discards stale scan results after a root is removed and re-added', async () => {
    const root = { machine, path: '/collections/one' };
    const initial = {
      rootPath: root.path,
      members: [member],
      diagnostics: [],
    };
    const stale = deferred<AgentTeamScanResult>();
    const current = deferred<AgentTeamScanResult>();
    const scanAgentTeams = vi
      .fn<AgentTeamScanPort['scanAgentTeams']>()
      .mockResolvedValueOnce(initial)
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => current.promise);
    const registry = new AgentTeamRegistry(
      new InMemoryAgentTeamRegistryStore(),
      { scanAgentTeams },
    );
    await registry.addRoot(root);

    const staleScan = registry.rescanRoot(root);
    registry.removeRoot(root);
    const currentScan = registry.addRoot(root);
    current.resolve({
      rootPath: root.path,
      members: [{ ...member, name: 'current-reviewer' }],
      diagnostics: [],
    });
    await currentScan;

    stale.resolve({ rootPath: root.path, members: [], diagnostics: [] });
    await expect(staleScan).rejects.toThrow('removed or replaced during scan');
    expect(registry.listMembers()[0]).toMatchObject({
      name: 'current-reviewer',
      status: 'active',
      discoveredBy: [root],
    });
  });

  it('persists immutable Profiles and allows duplicate aliases', async () => {
    const root = { machine, path: '/collections/one' };
    const port = new FakeScanPort();
    setResult(port, root, {
      members: [
        {
          ...member,
          harnesses: ['copilot', 'claude'],
        },
      ],
      diagnostics: [],
    });
    const store = new InMemoryAgentTeamRegistryStore();
    const ids = ['profile-1', 'profile-2', 'profile-3'];
    const registry = new AgentTeamRegistry(
      store,
      port,
      () => 100,
      () => ids.shift() ?? 'unexpected',
    );
    await registry.addRoot(root);

    const first = registry.createProfile({
      launchKind: 'agent-team-manifest',
      alias: 'Reviewer',
      agentletId: machine,
      manifestPath: member.manifestPath,
      harness: 'copilot',
      workingDirPath: '/workspaces/reviewer',
    });
    const second = registry.createProfile({
      launchKind: 'agent-team-manifest',
      alias: 'Reviewer',
      agentletId: machine,
      manifestPath: member.manifestPath,
      harness: 'copilot',
      workingDirPath: '/workspaces/reviewer-lowercase',
    });
    const command = registry.createProfile({
      launchKind: 'acp-command',
      alias: 'Reviewer',
      agentletId: machine,
      command: 'copilot --acp',
      workingDirPath: '/workspaces/direct',
      metadata: { cliId: 'copilot' },
    });

    expect(first).toMatchObject({
      id: 'profile-1',
      launch: { kind: 'agent-team-manifest' },
      preparation: { status: 'not_prepared' },
    });
    expect(second.id).toBe('profile-2');
    expect(command).toMatchObject({
      id: 'profile-3',
      launch: { kind: 'acp-command', command: 'copilot --acp' },
      metadata: { cliId: 'copilot' },
    });
    expect(registry.listProfiles()).toHaveLength(3);
    expect(registry.listSelectableProfileIds()).toEqual(['profile-3']);
    expect(registry.listMemberSummaries()).toEqual([
      expect.objectContaining({
        machine,
        manifestPath: member.manifestPath,
        profileCount: 2,
        preparationCounts: {
          not_prepared: 2,
          setting_up: 0,
          ready: 0,
          error: 0,
        },
      }),
    ]);
    expect(
      registry.getMemberDetail(machine, member.manifestPath).profiles,
    ).toHaveLength(2);
    expect(
      registry.patchProfile(first.id, { alias: 'Primary Reviewer' }),
    ).toMatchObject({
      alias: 'Primary Reviewer',
      launch: { harness: 'copilot' },
      workingDirPath: '/workspaces/reviewer',
    });

    const restored = new AgentTeamRegistry(store, port);
    expect(restored.getProfile(first.id)).toMatchObject({
      alias: 'Primary Reviewer',
      preparation: { status: 'not_prepared' },
    });
    expect(restored.deleteProfile(second.id)).toBe(true);
    expect(restored.deleteProfile(second.id)).toBe(false);
  });

  it('rejects manifest Profiles for missing members and undeclared harnesses', async () => {
    const root = { machine, path: '/collections/one' };
    const port = new FakeScanPort();
    setResult(port, root, { members: [member], diagnostics: [] });
    const registry = new AgentTeamRegistry(
      new InMemoryAgentTeamRegistryStore(),
      port,
    );
    await registry.addRoot(root);

    expect(() =>
      registry.createProfile({
        launchKind: 'agent-team-manifest',
        alias: 'Reviewer',
        agentletId: machine,
        manifestPath: member.manifestPath,
        harness: 'claude',
        workingDirPath: '/workspaces/reviewer',
      }),
    ).toThrow('is not declared');

    registry.removeRoot(root);
    expect(() =>
      registry.createProfile({
        launchKind: 'agent-team-manifest',
        alias: 'Reviewer',
        agentletId: machine,
        manifestPath: member.manifestPath,
        harness: 'copilot',
        workingDirPath: '/workspaces/reviewer',
      }),
    ).toThrow('member is missing');
  });
});
