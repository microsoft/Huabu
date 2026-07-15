import { describe, expect, it, vi } from 'vitest';

import { AgentTeamRegistry } from './registry.js';
import { InMemoryAgentTeamRegistryStore } from './store.js';

import type {
  AgentTeamControlPort,
  AgentTeamRegistryState,
  AgentTeamSecretStore,
} from './types.js';
import type {
  AgentTeamSetupProgressParams,
  AgentTeamSetupStartResult,
} from '@agentlet/protocol';

class EmptySecretStore implements AgentTeamSecretStore {
  get(): string | null {
    return null;
  }

  async setMany(): Promise<void> {}
}

class FakeControlPort implements AgentTeamControlPort {
  memberEnv: Awaited<
    ReturnType<AgentTeamControlPort['scanAgentTeams']>
  >['members'][number]['env'] = [];
  readonly setupAgentTeam = vi.fn<AgentTeamControlPort['setupAgentTeam']>(
    async (_machine, params): Promise<AgentTeamSetupStartResult> => ({
      operationId: params.operationId,
      accepted: true,
    }),
  );
  readonly cancelAgentTeamSetup = vi.fn<
    AgentTeamControlPort['cancelAgentTeamSetup']
  >(async (_machine, params) => ({
    operationId: params.operationId,
    cancelled: true,
  }));
  readonly validateAgentTeam = vi.fn<AgentTeamControlPort['validateAgentTeam']>(
    async () => ({ valid: true, issues: [] }),
  );
  readonly handlers = new Set<
    (machine: string, progress: AgentTeamSetupProgressParams) => void
  >();

  listAgentTeamMachines() {
    return [{ machine: 'machine-a', hostname: 'machine-a', platform: 'linux' }];
  }

  onAgentTeamMachinesChanged(): () => void {
    return () => {};
  }

  async scanAgentTeams(_machine: string, params: { rootPath: string }) {
    return {
      rootPath: params.rootPath,
      members: [
        {
          name: 'reviewer',
          manifestPath: '/teams/reviewer/agentlet.yaml',
          description: 'Reviews changes',
          harnesses: ['copilot'],
          env: structuredClone(this.memberEnv),
        },
      ],
      diagnostics: [],
    };
  }

  onAgentTeamSetupProgress(
    handler: (machine: string, progress: AgentTeamSetupProgressParams) => void,
  ): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(progress: AgentTeamSetupProgressParams): void {
    for (const handler of this.handlers) handler('machine-a', progress);
  }
}

async function createDeployment(options?: {
  store?: InMemoryAgentTeamRegistryStore;
  control?: FakeControlPort;
  ids?: string[];
  now?: () => number;
}): Promise<{
  registry: AgentTeamRegistry;
  store: InMemoryAgentTeamRegistryStore;
  control: FakeControlPort;
  deploymentId: string;
}> {
  const store = options?.store ?? new InMemoryAgentTeamRegistryStore();
  const control = options?.control ?? new FakeControlPort();
  const ids = options?.ids ?? ['profile-1', 'operation-1'];
  const registry = new AgentTeamRegistry(
    store,
    control,
    options?.now ?? (() => 100),
    () => ids.shift() ?? 'unexpected-id',
    new EmptySecretStore(),
    control,
  );
  await registry.addRoot({ machine: 'machine-a', path: '/teams' });
  const profile = registry.createProfile({
    launchKind: 'agent-team-manifest',
    alias: 'Reviewer',
    agentletId: 'machine-a',
    manifestPath: '/teams/reviewer/agentlet.yaml',
    harness: 'copilot',
    workingDirPath: '/teams/reviewer/workspaces/copilot',
  });
  return {
    registry,
    store,
    control,
    deploymentId: profile.id,
  };
}

describe('Agent Team setup state machine', () => {
  it('persists progress and ready completion', async () => {
    let time = 100;
    const { registry, store, control, deploymentId } = await createDeployment({
      now: () => ++time,
    });
    expect(registry.listSelectableProfileIds()).toEqual([]);

    await expect(registry.setupProfile(deploymentId)).resolves.toMatchObject({
      preparation: {
        status: 'setting_up',
        operationId: 'operation-1',
      },
    });
    expect(control.setupAgentTeam).toHaveBeenCalledWith('machine-a', {
      operationId: 'operation-1',
      manifestPath: '/teams/reviewer/agentlet.yaml',
      harness: 'copilot',
      workingDirPath: '/teams/reviewer/workspaces/copilot',
    });
    const save = vi.spyOn(store, 'save');

    control.emit({
      operationId: 'operation-1',
      type: 'phase',
      phase: 'installing_tools',
      status: 'started',
      message: 'Installing CLI tools',
    });
    expect(save).not.toHaveBeenCalled();
    control.emit({
      operationId: 'operation-1',
      type: 'completed',
      workingDirPath: '/teams/reviewer/workspaces/copilot',
    });
    expect(save).toHaveBeenCalledOnce();

    expect(registry.getProfile(deploymentId)).toMatchObject({
      preparation: { status: 'ready' },
    });
    expect(
      registry.getMemberDetail('machine-a', '/teams/reviewer/agentlet.yaml')
        .profiles[0]?.setupLog,
    ).toMatchObject([
      {
        phase: 'installing_tools',
        status: 'started',
        message: 'Installing CLI tools',
      },
    ]);
    expect(registry.listSelectableProfileIds()).toEqual([deploymentId]);
  });

  it('accepts terminal progress before the setup request returns', async () => {
    const { registry, control, deploymentId } = await createDeployment();
    control.setupAgentTeam.mockImplementationOnce(async (_machine, params) => {
      control.emit({
        operationId: params.operationId,
        type: 'completed',
        workingDirPath: params.workingDirPath,
      });
      return { operationId: params.operationId, accepted: true };
    });

    await expect(registry.setupProfile(deploymentId)).resolves.toMatchObject({
      preparation: { status: 'ready' },
    });
  });

  it('records start failures and supports explicit retry', async () => {
    const control = new FakeControlPort();
    const startError = Object.assign(new Error('daemon unavailable'), {
      data: { code: 'placement_unavailable' },
    });
    control.setupAgentTeam.mockRejectedValueOnce(startError);
    const { registry, deploymentId } = await createDeployment({
      control,
      ids: ['profile-1', 'operation-1', 'operation-2'],
    });

    await expect(registry.setupProfile(deploymentId)).rejects.toThrow(
      'daemon unavailable',
    );
    expect(registry.getProfile(deploymentId)).toMatchObject({
      preparation: {
        status: 'error',
        error: {
          code: 'placement_unavailable',
          message: 'daemon unavailable',
        },
      },
    });

    await expect(registry.setupProfile(deploymentId)).resolves.toMatchObject({
      preparation: { status: 'setting_up', operationId: 'operation-2' },
    });
    control.emit({
      operationId: 'operation-2',
      type: 'completed',
      workingDirPath: '/teams/reviewer/workspaces/copilot',
    });
    expect(
      registry.getProfile(deploymentId)?.launch.kind ===
        'agent-team-manifest' &&
        registry.getProfile(deploymentId)?.preparation.status,
    ).toBe('ready');
  });

  it('cancels active setup explicitly', async () => {
    const { registry, control, deploymentId } = await createDeployment();
    await registry.setupProfile(deploymentId);

    await expect(
      registry.cancelProfileSetup(deploymentId),
    ).resolves.toMatchObject({
      preparation: { status: 'not_prepared' },
    });
    expect(control.cancelAgentTeamSetup).toHaveBeenCalledWith('machine-a', {
      operationId: 'operation-1',
    });
  });

  it('accepts a terminal event that wins the cancellation race', async () => {
    const { registry, control, deploymentId } = await createDeployment();
    await registry.setupProfile(deploymentId);
    control.cancelAgentTeamSetup.mockImplementationOnce(
      async (_machine, params) => {
        control.emit({
          operationId: params.operationId,
          type: 'completed',
          workingDirPath: '/teams/reviewer/workspaces/copilot',
        });
        return { operationId: params.operationId, cancelled: false };
      },
    );

    await expect(
      registry.cancelProfileSetup(deploymentId),
    ).resolves.toMatchObject({
      preparation: { status: 'ready' },
    });
  });

  it('blocks deletion while setup is active', async () => {
    const { registry, deploymentId } = await createDeployment();
    await registry.setupProfile(deploymentId);
    expect(() => registry.deleteProfile(deploymentId)).toThrow('Cancel');
  });

  it('truncates logs for retry and deletes them with the Profile', async () => {
    const { registry, store, control, deploymentId } = await createDeployment({
      ids: ['profile-1', 'operation-1', 'operation-2'],
    });
    await registry.setupProfile(deploymentId);
    control.emit({
      operationId: 'operation-1',
      type: 'phase',
      phase: 'installing_tools',
      status: 'started',
      message: 'Old attempt',
    });
    control.emit({
      operationId: 'operation-1',
      type: 'failed',
      error: { code: 'setup_failed', message: 'Failed' },
    });

    await registry.setupProfile(deploymentId);
    expect(store.loadSetupLog(deploymentId)).toEqual([]);
    control.emit({
      operationId: 'operation-2',
      type: 'completed',
      workingDirPath: '/teams/reviewer/workspaces/copilot',
    });
    expect(registry.deleteProfile(deploymentId)).toBe(true);
    expect(store.loadSetupLog(deploymentId)).toEqual([]);
  });

  it('rejects enable before required member Configs are complete', async () => {
    const control = new FakeControlPort();
    control.memberEnv = [
      {
        name: 'TOKEN',
        description: 'Service token',
        required: true,
        secret: true,
      },
    ];
    const { registry, deploymentId } = await createDeployment({ control });

    await expect(registry.setupProfile(deploymentId)).rejects.toThrow(
      'missing required Configs: TOKEN',
    );
    expect(control.setupAgentTeam).not.toHaveBeenCalled();
    expect(registry.getProfile(deploymentId)).toMatchObject({
      preparation: { status: 'not_prepared' },
    });
  });

  it('keeps cancellation failures visible', async () => {
    const control = new FakeControlPort();
    control.cancelAgentTeamSetup.mockRejectedValueOnce(
      new Error('cancel transport failed'),
    );
    const { registry, deploymentId } = await createDeployment({ control });
    await registry.setupProfile(deploymentId);

    await expect(registry.cancelProfileSetup(deploymentId)).rejects.toThrow(
      'cancel transport failed',
    );
    expect(registry.getProfile(deploymentId)).toMatchObject({
      preparation: {
        status: 'error',
        error: {
          code: 'setup_cancel_failed',
          message: 'cancel transport failed',
        },
      },
    });
  });

  it('recovers persisted in-flight setup as interrupted', () => {
    const state: AgentTeamRegistryState = {
      roots: [],
      members: [],
      configs: [],
      profiles: [
        {
          id: 'profile-1',
          alias: 'Reviewer',
          agentletId: 'machine-a',
          workingDirPath: '/teams/reviewer/workspaces/copilot',
          launch: {
            kind: 'agent-team-manifest',
            manifestPath: '/teams/reviewer/agentlet.yaml',
            harness: 'copilot',
          },
          preparation: {
            status: 'setting_up',
            operationId: 'operation-1',
            startedAt: 50,
          },
        },
      ],
    };
    const store = new InMemoryAgentTeamRegistryStore(state);

    const registry = new AgentTeamRegistry(
      store,
      new FakeControlPort(),
      () => 100,
    );

    expect(registry.getProfile('profile-1')).toMatchObject({
      preparation: {
        status: 'error',
        failedAt: 100,
        error: { code: 'setup_interrupted' },
      },
    });
    expect(store.load()).toEqual({
      ...state,
      profiles: [
        expect.objectContaining({
          preparation: expect.objectContaining({
            status: 'error',
            error: expect.objectContaining({ code: 'setup_interrupted' }),
          }),
        }),
      ],
    });
  });

  it('marks a retained Profile unavailable after runtime validation fails', async () => {
    const control = new FakeControlPort();
    control.validateAgentTeam.mockResolvedValue({
      valid: false,
      issues: [
        {
          code: 'workspace_not_ready',
          message: 'Workspace marker is missing',
        },
      ],
    });
    const { registry, deploymentId } = await createDeployment({ control });
    const profile = registry.getProfile(deploymentId);
    if (!profile) throw new Error('Expected Profile');

    await expect(
      registry.resolveManifestRuntime({
        profileId: profile.id,
        agentletId: profile.agentletId,
        workingDirPath: profile.workingDirPath,
        launch: profile.launch,
      }),
    ).rejects.toMatchObject({ code: 'workspace_invalid' });

    expect(registry.getProfile(deploymentId)).toMatchObject({
      preparation: {
        status: 'error',
        failedAt: 100,
        error: {
          code: 'workspace_invalid',
          message: 'Workspace marker is missing',
        },
      },
    });
  });

  it('unsubscribes from progress events on dispose', async () => {
    const { registry, control } = await createDeployment();
    expect(control.handlers.size).toBe(1);
    registry.dispose();
    expect(control.handlers.size).toBe(0);
  });
});
