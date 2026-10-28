// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAgentProfileRegistry } from '@agenetes/agent-profile';
import { describe, expect, it, vi } from 'vitest';

import {
  HarnessProfileDiscoveryError,
  registerHarnessProfileDiscovery,
} from './harness-profile-discovery.js';
import { AgentDefaultsService } from '../agent-defaults.js';

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
      installHint: 'Install Copilot',
      status: 'ready',
      capabilities: {
        autoApprove: false,
        customLaunchCommand: false,
      },
      workingDirPath: '/home/user/.agentlet/workspace/copilot',
    },
  ],
};

type Event = { agentletId: string; status: 'connected' | 'disconnected' };
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(initialMachines = ['machine-a']) {
  const connected = new Set(initialMachines);
  let listener: (event: Event) => void = () => {};
  let nextId = 0;
  const profiles: AgentProfile[] = [];
  const registry = {
    listProfiles: () => profiles,
    createProfile: vi.fn((input: CreateAgentProfileInput): AgentProfile => {
      const profile: AgentProfile = {
        id: `profile-${++nextId}`,
        alias: input.alias,
        visible: input.visible,
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
    getAgentlets: () =>
      [...connected].map((agentletId) => ({
        agentletId,
        agentletProfile: {
          machine: {
            hostname: agentletId,
            platform: 'linux',
            arch: 'x64',
          },
        },
      })),
    onAgentletsChanged: (handler: (event: Event) => void) => {
      listener = handler;
      return vi.fn();
    },
    discoverHarnesses: vi.fn(
      async (): Promise<HarnessDiscoveryResult> => observation,
    ),
  };
  const log = { info: vi.fn(), warn: vi.fn() };
  let discovery: ReturnType<typeof registerHarnessProfileDiscovery>;
  const start = () => {
    discovery = registerHarnessProfileDiscovery({
      gateway,
      getRegistry: () => registry,
      log,
    });
    return discovery.dispose;
  };
  return {
    start,
    profiles,
    registry,
    gateway,
    log,
    discover: (agentletId = 'machine-a') => discovery.discover(agentletId),
    emit: (event: Event) => {
      if (event.status === 'connected') connected.add(event.agentletId);
      else connected.delete(event.agentletId);
      listener(event);
    },
  };
}

describe('automatic ordinary Profile provisioning', () => {
  it('provisions an idempotent exact-device hidden proxy outside the manual picker result', async () => {
    const context = setup([]);
    context.gateway.discoverHarnesses.mockResolvedValue({
      harnesses: [
        {
          ...observation.harnesses[0]!,
          id: 'proxy',
          displayName: 'Filesystem Proxy',
        },
      ],
    });
    const dispose = context.start();
    context.emit({ agentletId: 'machine-a', status: 'connected' });
    await flush();
    await context.discover();
    expect(context.profiles).toHaveLength(1);
    expect(context.profiles[0]).toMatchObject({
      agentletId: 'machine-a',
      visible: false,
      launch: { kind: 'acp-harness', harnessId: 'proxy' },
    });
    expect((await context.discover()).harnesses).toHaveLength(0);
    dispose();
  });
  it('shares automatic/manual overlap, then performs fresh idempotent discovery', async () => {
    const context = setup();
    let finish!: (result: HarnessDiscoveryResult) => void;
    context.gateway.discoverHarnesses.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const dispose = context.start();
    const first = context.discover();
    expect(context.discover()).toBe(first);
    expect(context.gateway.discoverHarnesses).toHaveBeenCalledOnce();
    finish(observation);
    expect((await first).harnesses[0]).toMatchObject({
      profileStatus: 'created',
      profileId: 'profile-1',
    });
    const original = structuredClone(context.profiles);
    const second = await context.discover();
    expect(second.harnesses[0]).toMatchObject({
      profileStatus: 'existing',
      profileId: 'profile-1',
    });
    expect(context.gateway.discoverHarnesses).toHaveBeenCalledTimes(2);
    expect(context.profiles).toEqual(original);
    dispose();
  });

  it('lets different devices discover independently', async () => {
    const context = setup(['machine-a', 'machine-b']);
    let finishA!: (result: HarnessDiscoveryResult) => void;
    context.gateway.discoverHarnesses.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishA = resolve;
        }),
    );
    const dispose = context.start();
    const second = await context.discover('machine-b');
    expect(second.agentletId).toBe('machine-b');
    expect(context.profiles.map((profile) => profile.agentletId)).toEqual([
      'machine-b',
    ]);
    finishA(observation);
    await context.discover();
    expect(context.profiles).toHaveLength(2);
    dispose();
  });

  it.each(['disconnect', 'reconnect', 'dispose'] as const)(
    'explicitly rejects a manual completion after %s',
    async (action) => {
      const context = setup();
      let finish!: (result: HarnessDiscoveryResult) => void;
      context.gateway.discoverHarnesses.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const dispose = context.start();
      const pending = context.discover();
      const rejected = expect(pending).rejects.toMatchObject({
        code: 'harness_discovery_stale',
        status: 409,
      });
      if (action === 'dispose') dispose();
      else
        context.emit({
          agentletId: 'machine-a',
          status: action === 'disconnect' ? 'disconnected' : 'connected',
        });
      finish(observation);
      await rejected;
      dispose();
    },
  );

  it('does not let an old finalizer clear the replacement connection request', async () => {
    const context = setup();
    const connection = {
      ...context.gateway.getAgentlets()[0],
      connectedAt: new Date('2026-01-01T00:00:00Z'),
    };
    context.gateway.getAgentlets = () => [connection];
    let finishOld!: (result: HarnessDiscoveryResult) => void;
    let finishNew!: (result: HarnessDiscoveryResult) => void;
    context.gateway.discoverHarnesses
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishNew = resolve;
          }),
      );
    const dispose = context.start();
    const old = context.discover();
    const rejected = expect(old).rejects.toBeInstanceOf(
      HarnessProfileDiscoveryError,
    );
    context.emit({ agentletId: 'machine-a', status: 'disconnected' });
    context.emit({ agentletId: 'machine-a', status: 'connected' });
    expect(context.gateway.getAgentlets()[0]).toBe(connection);
    expect(connection.connectedAt.toISOString()).toBe(
      '2026-01-01T00:00:00.000Z',
    );
    const replacement = context.discover();
    finishOld(observation);
    await rejected;
    expect(context.discover()).toBe(replacement);
    expect(context.gateway.discoverHarnesses).toHaveBeenCalledTimes(2);
    finishNew(observation);
    await replacement;
    expect(context.registry.createProfile).toHaveBeenCalledOnce();
    dispose();
  });

  it('reports partial persistence and retries without duplicating saved additions', async () => {
    const context = setup();
    const create = context.registry.createProfile.getMockImplementation();
    if (!create) throw new Error('Expected the test registry implementation');
    context.registry.createProfile
      .mockImplementationOnce(create)
      .mockImplementationOnce(() => {
        throw new Error('Disk full');
      });
    context.gateway.discoverHarnesses.mockResolvedValue({
      harnesses: [
        observation.harnesses[0],
        { ...observation.harnesses[0], id: 'codex' },
      ],
    });
    const dispose = context.start();
    await expect(context.discover()).rejects.toMatchObject({
      code: 'harness_reconciliation_failed',
      status: 500,
      details: { createdProfileIds: ['profile-1'] },
    });
    expect(context.profiles).toHaveLength(1);
    const result = await context.discover();
    expect(result.harnesses.map((harness) => harness.profileStatus)).toEqual([
      'existing',
      'created',
    ]);
    expect(context.profiles).toHaveLength(2);
    dispose();
  });

  it('keeps readiness and workspace diagnostics distinct and excludes Custom', async () => {
    const context = setup();
    context.gateway.discoverHarnesses.mockResolvedValue({
      harnesses: [
        { ...observation.harnesses[0], id: 'custom' },
        {
          ...observation.harnesses[0],
          id: 'claude',
          status: 'adapter-missing',
        },
        { ...observation.harnesses[0], id: 'codex', status: 'not-found' },
        {
          ...observation.harnesses[0],
          workingDirPath: undefined,
          diagnostics: [
            { code: 'workspace_failed', message: 'Permission denied' },
          ],
        },
      ],
    });
    const dispose = context.start();
    const result = await context.discover();
    expect(
      result.harnesses.map(({ id, status, profileStatus }) => ({
        id,
        status,
        profileStatus,
      })),
    ).toEqual([
      { id: 'claude', status: 'adapter-missing', profileStatus: 'skipped' },
      { id: 'codex', status: 'not-found', profileStatus: 'skipped' },
      { id: 'copilot', status: 'ready', profileStatus: 'skipped' },
    ]);
    expect(result.harnesses[2].diagnostics?.[0].code).toBe('workspace_failed');
    expect(context.registry.createProfile).not.toHaveBeenCalled();
    dispose();
  });

  it('rejects inactive targets and distinguishes unsupported discovery', async () => {
    const context = setup();
    const dispose = context.start();
    await context.discover();
    await expect(context.discover('offline')).rejects.toMatchObject({
      code: 'agentlet_unavailable',
    });
    context.gateway.discoverHarnesses.mockRejectedValueOnce(
      Object.assign(new Error('old daemon'), {
        code: 'harness_discovery_unsupported',
      }),
    );
    await expect(context.discover()).rejects.toMatchObject({
      code: 'harness_discovery_unsupported',
      status: 503,
    });
    expect(context.profiles).toHaveLength(1);
    dispose();
  });

  it('does not reconcile a resolved reply when disconnect wins before its continuation', async () => {
    const context = setup();
    let finish!: (result: HarnessDiscoveryResult) => void;
    context.gateway.discoverHarnesses.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const dispose = context.start();
    const rejected = expect(context.discover()).rejects.toMatchObject({
      code: 'harness_discovery_stale',
    });
    finish(observation);
    context.emit({ agentletId: 'machine-a', status: 'disconnected' });
    await rejected;
    expect(context.registry.createProfile).not.toHaveBeenCalled();
    dispose();
  });

  it('reports registry unavailability without creating any Profiles', async () => {
    const context = setup();
    const discovery = registerHarnessProfileDiscovery({
      gateway: context.gateway,
      getRegistry: () => null,
      log: context.log,
    });
    await expect(discovery.discover('machine-a')).rejects.toMatchObject({
      code: 'profile_registry_unavailable',
      status: 503,
    });
    expect(context.registry.createProfile).not.toHaveBeenCalled();
    discovery.dispose();
    await expect(discovery.discover('machine-a')).rejects.toMatchObject({
      code: 'harness_discovery_stale',
    });
    expect(context.gateway.discoverHarnesses).toHaveBeenCalledOnce();
  });

  it('never automatically provisions the manual Custom wrapper', async () => {
    const context = setup();
    context.gateway.discoverHarnesses.mockResolvedValue({
      harnesses: observation.harnesses.map((harness) => ({
        ...harness,
        id: 'custom',
        workingDirPath: '/custom',
      })),
    });
    const dispose = context.start();
    await flush();
    expect(context.registry.createProfile).not.toHaveBeenCalled();
    dispose();
  });

  it('creates a persisted typed Profile with the daemon workspace and no auto-approval option', async () => {
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
      alias: 'GitHub Copilot (machine-a: linux x64)',
      agentletId: 'machine-a',
      workingDirPath: '/home/user/.agentlet/workspace/copilot',
      launch: {
        kind: 'acp-harness',
        harnessId: 'copilot',
        options: undefined,
      },
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

  it('uses structured harness configuration for ready definitions', async () => {
    const context = setup();
    context.gateway.discoverHarnesses.mockResolvedValue({
      harnesses: observation.harnesses.map((harness) => ({
        ...harness,
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

  it.each([true, false] as const)(
    'defaults structured auto-approval only when the definition supports it (%s)',
    async (autoApprove) => {
      const context = setup();
      context.gateway.discoverHarnesses.mockResolvedValue({
        harnesses: observation.harnesses.map((harness) => ({
          ...harness,
          capabilities: {
            autoApprove,
            customLaunchCommand: false,
          },
        })),
      });
      const dispose = context.start();
      await flush();
      expect(context.profiles[0]?.launch).toEqual({
        kind: 'acp-harness',
        harnessId: 'copilot',
        options: autoApprove ? { autoApprove: true } : undefined,
      });
      dispose();
    },
  );

  it.each([
    { kind: 'acp-harness', harnessId: 'copilot' },
    {
      kind: 'acp-harness',
      harnessId: 'copilot',
      options: { autoApprove: false },
    },
  ] satisfies AgentProfile['launch'][])(
    'preserves existing automatic launch settings on reconnect: %j',
    async (launch) => {
      const context = setup();
      const existing: AgentProfile = {
        id: 'existing',
        alias: 'My Agent',
        agentletId: 'machine-a',
        workingDirPath: '/my/work',
        launch,
        customData: {
          discoveredAgent: {
            version: 1,
            agentletId: 'machine-a',
            harnessId: 'copilot',
          },
        },
      };
      context.profiles.push(existing);
      const original = structuredClone(existing);
      context.gateway.discoverHarnesses.mockResolvedValue({
        harnesses: observation.harnesses.map((harness) => ({
          ...harness,
          capabilities: {
            autoApprove: true,
            customLaunchCommand: false,
          },
        })),
      });
      const dispose = context.start();
      await flush();
      context.emit({ agentletId: 'machine-a', status: 'connected' });
      await flush();
      expect(context.registry.createProfile).not.toHaveBeenCalled();
      expect(context.profiles).toEqual([original]);
      dispose();
    },
  );

  it('creates one typed successor without changing the legacy Profile, default, or execution snapshot', async () => {
    const storageDir = mkdtempSync(join(tmpdir(), 'huabu-discovery-typed-'));
    const context = setup();
    let dispose: (() => void) | undefined;
    try {
      const registry = createAgentProfileRegistry({ storageDir });
      const legacy = registry.createProfile({
        launchKind: 'acp-command',
        alias: 'GitHub Copilot (machine-a: linux x64)',
        agentletId: 'machine-a',
        workingDirPath: '/custom/work',
        command: 'copilot --acp --model old-model',
        metadata: { cliId: 'copilot' },
        customData: {
          discoveredAgent: {
            version: 1,
            agentletId: 'machine-a',
            harnessId: 'copilot',
          },
          preference: 'preserved',
        },
      });
      const snapshot = registry.snapshotProfile(legacy.id);
      const savedDefaults = {
        profileId: legacy.id,
        functionalModel: 'saved-model',
      };
      const write = vi.fn();
      const defaults = new AgentDefaultsService({
        read: () => savedDefaults,
        write,
      });
      context.gateway.discoverHarnesses.mockResolvedValue({
        harnesses: observation.harnesses.map((harness) => ({
          ...harness,
          capabilities: {
            autoApprove: true,
            customLaunchCommand: false,
          },
        })),
      });
      const start = (current: typeof registry) =>
        registerHarnessProfileDiscovery({
          gateway: context.gateway,
          getRegistry: () => current,
          log: context.log,
          onProfilesDiscovered: (profiles) =>
            defaults.initializeAgentDefaults(profiles),
        }).dispose;
      dispose = start(registry);
      await flush();
      expect(context.log.warn).not.toHaveBeenCalled();
      expect(registry.listProfiles()).toHaveLength(2);
      const typed = registry
        .listProfiles()
        .find((profile) => profile.launch.kind === 'acp-harness');
      expect(typed).toMatchObject({
        alias: 'GitHub Copilot (machine-a: linux x64) [copilot]',
        workingDirPath: observation.harnesses[0].workingDirPath,
        launch: {
          kind: 'acp-harness',
          harnessId: 'copilot',
          options: { autoApprove: true },
        },
        customData: { discoveredAgent: legacy.customData?.discoveredAgent },
      });
      expect(typed?.id).not.toBe(legacy.id);
      expect(registry.getProfile(legacy.id)).toEqual(legacy);
      expect(registry.snapshotProfile(legacy.id)).toEqual(snapshot);
      if (!typed || typed.launch.kind !== 'acp-harness') {
        throw new Error('Expected a typed Profile');
      }
      registry.patchProfile(typed.id, {
        alias: legacy.alias,
        launch: { ...typed.launch, options: { autoApprove: false } },
      });
      context.emit({ agentletId: 'machine-a', status: 'connected' });
      context.emit({ agentletId: 'machine-a', status: 'connected' });
      await flush();
      expect(registry.listProfiles()).toHaveLength(2);
      const beforeRestart = registry.listProfiles();
      dispose();
      const restored = createAgentProfileRegistry({ storageDir });
      dispose = start(restored);
      await flush();
      expect(restored.listProfiles()).toEqual(beforeRestart);
      expect(defaults.getAgentDefaults()).toEqual(savedDefaults);
      expect(write).not.toHaveBeenCalled();
    } finally {
      dispose?.();
      rmSync(storageDir, { recursive: true, force: true });
    }
  });

  it('does not create a duplicate on repeated ready discovery', async () => {
    const context = setup();
    context.gateway.discoverHarnesses.mockResolvedValueOnce({
      harnesses: observation.harnesses.map((harness) => ({
        ...harness,
      })),
    });
    const dispose = context.start();
    await flush();
    context.emit({ agentletId: 'machine-a', status: 'connected' });
    await flush();
    expect(context.registry.createProfile).toHaveBeenCalledOnce();
    expect(context.profiles[0].launch.kind).toBe('acp-harness');
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
      }).dispose;
      await flush();
      const original = registry.listProfiles()[0]!;
      registry.patchProfile(original.id, { alias: 'Kept after restart' });
      dispose();

      const restored = createAgentProfileRegistry({ storageDir });
      dispose = registerHarnessProfileDiscovery({
        gateway: context.gateway,
        getRegistry: () => restored,
        log: context.log,
      }).dispose;
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

  it('persists the new default and preserves an explicit opt-out after restart', async () => {
    const storageDir = mkdtempSync(join(tmpdir(), 'huabu-discovery-approval-'));
    const context = setup();
    context.gateway.discoverHarnesses.mockResolvedValue({
      harnesses: observation.harnesses.map((harness) => ({
        ...harness,
        capabilities: {
          autoApprove: true,
          customLaunchCommand: false,
        },
      })),
    });
    let dispose: (() => void) | undefined;
    try {
      const registry = createAgentProfileRegistry({ storageDir });
      dispose = registerHarnessProfileDiscovery({
        gateway: context.gateway,
        getRegistry: () => registry,
        log: context.log,
      }).dispose;
      await flush();
      const profile = registry.listProfiles()[0];
      if (!profile)
        throw new Error('Expected an automatically discovered Profile');
      expect(profile.launch).toEqual({
        kind: 'acp-harness',
        harnessId: 'copilot',
        options: { autoApprove: true },
      });
      expect(
        createAgentProfileRegistry({ storageDir }).getProfile(profile.id),
      ).toEqual(profile);
      const edited = registry.patchProfile(profile.id, {
        expectedRevision: profile.revision ?? 0,
        launch: {
          kind: 'acp-harness',
          harnessId: 'copilot',
          options: { autoApprove: false },
        },
      });
      expect(profile.launch).toMatchObject({ options: { autoApprove: true } });
      dispose();
      const restored = createAgentProfileRegistry({ storageDir });
      dispose = registerHarnessProfileDiscovery({
        gateway: context.gateway,
        getRegistry: () => restored,
        log: context.log,
      }).dispose;
      await flush();
      expect(restored.listProfiles()).toEqual([edited]);
      expect(restored.getProfile(profile.id)?.launch).toMatchObject({
        options: { autoApprove: false },
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
        err: expect.objectContaining({
          code: 'harness_reconciliation_failed',
          cause: expect.objectContaining({ message: 'Disk write failed' }),
        }),
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
        { ...observation.harnesses[0]!, status: 'not-found' },
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
