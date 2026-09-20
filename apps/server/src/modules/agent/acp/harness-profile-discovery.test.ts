// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAgentProfileRegistry } from '@agenetes/agent-profile';
import { describe, expect, it, vi } from 'vitest';

import { registerHarnessProfileDiscovery } from './harness-profile-discovery.js';

import type {
  AgentProfile,
  CreateAgentProfileInput,
} from '@agenetes/agent-profile';
import type { HarnessDiscoveryResult } from '@agentlet/protocol';

const observation: HarnessDiscoveryResult = {
  harnesses: [
    {
      id: 'copilot',
      displayName: 'GitHub Copilot',
      binary: 'copilot',
      acpArgs: ['--acp'],
      autoApprove: { args: ['--allow-all'], position: 'after-acp' },
      installHint: 'Install Copilot',
      installed: true,
      workingDirPath: '/home/user/.agentlet/workspace/copilot',
    },
  ],
};

type Event = { agentletId: string; status: 'connected' | 'disconnected' };
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(initialMachines = ['machine-a']) {
  let listener: (event: Event) => void = () => {};
  let nextId = 0;
  const profiles: AgentProfile[] = [];
  const registry = {
    listProfiles: () => profiles,
    createProfile: vi.fn((input: CreateAgentProfileInput): AgentProfile => {
      const profile: AgentProfile = {
        id: `profile-${++nextId}`,
        alias: input.alias,
        agentletId: input.agentletId,
        workingDirPath: input.workingDirPath,
        launch:
          input.launchKind === 'acp-command'
            ? { kind: 'acp-command', command: input.command }
            : {
                kind: 'acp-harness',
                harnessId: input.harnessId,
                options: input.options,
              },
        metadata: input.metadata,
        customData: input.customData,
      };
      profiles.push(profile);
      return profile;
    }),
  };
  const gateway = {
    getAgentlets: () => initialMachines.map((agentletId) => ({ agentletId })),
    onAgentletsChanged: (handler: (event: Event) => void) => {
      listener = handler;
      return vi.fn();
    },
    discoverHarnesses: vi.fn(
      async (): Promise<HarnessDiscoveryResult> => observation,
    ),
  };
  const log = { info: vi.fn(), warn: vi.fn() };
  const start = () =>
    registerHarnessProfileDiscovery({
      gateway,
      getRegistry: () => registry,
      log,
    });
  return {
    start,
    profiles,
    registry,
    gateway,
    log,
    emit: (event: Event) => listener(event),
  };
}

describe('automatic ordinary Profile provisioning', () => {
  it('creates a persisted command Profile with the daemon workspace and no auto-approval flags', async () => {
    const context = setup();
    const dispose = context.start();
    await flush();
    expect(context.gateway.discoverHarnesses).toHaveBeenCalledWith(
      'machine-a',
      {
        prepareWorkspaces: true,
      },
    );
    expect(context.profiles[0]).toMatchObject({
      agentletId: 'machine-a',
      workingDirPath: '/home/user/.agentlet/workspace/copilot',
      launch: { kind: 'acp-command', command: 'copilot --acp' },
      customData: {
        discoveredAgent: {
          version: 1,
          agentletId: 'machine-a',
          harnessId: 'copilot',
        },
      },
    });
    dispose();
  });

  it('deduplicates repeated reports and preserves customized Profiles', async () => {
    const context = setup();
    const dispose = context.start();
    await flush();
    context.profiles[0]!.alias = 'My helper';
    context.profiles[0]!.customData!.preference = 'kept';
    context.emit({ agentletId: 'machine-a', status: 'connected' });
    context.emit({ agentletId: 'machine-a', status: 'connected' });
    await flush();
    expect(context.registry.createProfile).toHaveBeenCalledTimes(1);
    expect(context.profiles[0]).toMatchObject({
      id: 'profile-1',
      alias: 'My helper',
      customData: { preference: 'kept' },
    });
    dispose();
  });

  it('uses structured harness configuration only when the daemon advertises it', async () => {
    const context = setup();
    context.gateway.discoverHarnesses.mockResolvedValue({
      harnesses: observation.harnesses.map((harness) => ({
        ...harness,
        launchVersion: 1,
      })),
    });
    const dispose = context.start();
    await flush();
    expect(context.profiles[0]?.launch).toEqual({
      kind: 'acp-harness',
      harnessId: 'copilot',
      options: undefined,
    });
    context.emit({ agentletId: 'machine-a', status: 'connected' });
    await flush();
    expect(context.registry.createProfile).toHaveBeenCalledOnce();
    dispose();
  });

  it('allows manual duplicates and isolates different machines', async () => {
    const context = setup(['machine-a', 'machine-b']);
    context.profiles.push({
      id: 'manual',
      alias: 'My project',
      agentletId: 'machine-a',
      workingDirPath: '/my/project',
      launch: { kind: 'acp-command', command: 'copilot --acp' },
      metadata: { cliId: 'copilot' },
    });
    const dispose = context.start();
    await flush();
    expect(context.profiles).toHaveLength(3);
    expect(context.profiles[0]!.workingDirPath).toBe('/my/project');
    expect(
      context.profiles.slice(1).map((profile) => profile.agentletId),
    ).toEqual(['machine-a', 'machine-b']);
    dispose();
  });

  it('deduplicates against the durable registry after a host restart', async () => {
    const storageDir = mkdtempSync(join(tmpdir(), 'huabu-discovery-'));
    const context = setup();
    let dispose: (() => void) | undefined;
    try {
      const registry = createAgentProfileRegistry({ storageDir });
      dispose = registerHarnessProfileDiscovery({
        gateway: context.gateway,
        getRegistry: () => registry,
        log: context.log,
      });
      await flush();
      const original = registry.listProfiles()[0]!;
      registry.patchProfile(original.id, { alias: 'Kept after restart' });
      dispose();

      const restored = createAgentProfileRegistry({ storageDir });
      dispose = registerHarnessProfileDiscovery({
        gateway: context.gateway,
        getRegistry: () => restored,
        log: context.log,
      });
      await flush();
      expect(restored.listProfiles()).toHaveLength(1);
      expect(restored.listProfiles()[0]).toMatchObject({
        id: original.id,
        alias: 'Kept after restart',
      });
    } finally {
      dispose?.();
      rmSync(storageDir, { recursive: true, force: true });
    }
  });

  it('surfaces a persistence failure and retries on the next discovery', async () => {
    const context = setup();
    context.registry.createProfile.mockImplementationOnce(() => {
      throw new Error('Disk write failed');
    });
    const dispose = context.start();
    await flush();
    expect(context.profiles).toEqual([]);
    expect(context.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.objectContaining({ message: 'Disk write failed' }),
      }),
      '[acp] harness discovery failed',
    );
    context.emit({ agentletId: 'machine-a', status: 'connected' });
    await flush();
    expect(context.profiles).toHaveLength(1);
    dispose();
  });

  it('permits recreation on discovery after ordinary deletion', async () => {
    const context = setup();
    const dispose = context.start();
    await flush();
    context.profiles.splice(0, 1);
    context.emit({ agentletId: 'machine-a', status: 'connected' });
    await flush();
    expect(context.profiles).toHaveLength(1);
    expect(context.profiles[0]!.id).toBe('profile-2');
    dispose();
  });

  it.each(['disconnect', 'dispose', 'reconnect'] as const)(
    'rejects old completions after %s',
    async (action) => {
      const context = setup();
      let resolveOld!: (result: HarnessDiscoveryResult) => void;
      context.gateway.discoverHarnesses.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      );
      const dispose = context.start();
      if (action === 'dispose') dispose();
      else
        context.emit({
          agentletId: 'machine-a',
          status: action === 'disconnect' ? 'disconnected' : 'connected',
        });
      await flush();
      const count = context.registry.createProfile.mock.calls.length;
      resolveOld({
        harnesses: observation.harnesses.map((harness) => ({
          ...harness,
          id: 'stale',
        })),
      });
      await flush();
      expect(context.registry.createProfile).toHaveBeenCalledTimes(count);
      expect(
        context.profiles.some((profile) => profile.metadata?.cliId === 'stale'),
      ).toBe(false);
      dispose();
    },
  );

  it('reports transport failure and retains existing Profiles', async () => {
    const context = setup();
    const dispose = context.start();
    await flush();
    context.gateway.discoverHarnesses.mockRejectedValueOnce(
      new Error('unsupported'),
    );
    context.emit({ agentletId: 'machine-a', status: 'connected' });
    await flush();
    expect(context.profiles).toHaveLength(1);
    expect(context.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        agentletId: 'machine-a',
        err: expect.any(Error),
      }),
      '[acp] harness discovery failed',
    );
    dispose();
  });

  it('does not create missing harnesses or Profiles without usable workspaces', async () => {
    const context = setup();
    context.gateway.discoverHarnesses.mockResolvedValueOnce({
      harnesses: [
        { ...observation.harnesses[0]!, installed: false },
        {
          ...observation.harnesses[0]!,
          workingDirPath: undefined,
          diagnostics: [
            { code: 'workspace_failed', message: 'Permission denied' },
          ],
        },
      ],
    });
    const dispose = context.start();
    await flush();
    expect(context.profiles).toEqual([]);
    expect(context.log.warn).toHaveBeenCalled();
    dispose();
  });
});
