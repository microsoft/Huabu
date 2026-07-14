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
  const ids = options?.ids ?? ['deployment-1', 'operation-1'];
  const registry = new AgentTeamRegistry(
    store,
    control,
    options?.now ?? (() => 100),
    () => ids.shift() ?? 'unexpected-id',
    new EmptySecretStore(),
    control,
  );
  await registry.addRoot({ machine: 'machine-a', path: '/teams' });
  const deployment = registry.createDeployment({
    alias: 'Reviewer',
    machine: 'machine-a',
    manifestPath: '/teams/reviewer/agentlet.yaml',
    harness: 'copilot',
    workingDirPath: '/teams/reviewer/workspaces/copilot',
  });
  return {
    registry,
    store,
    control,
    deploymentId: deployment.id,
  };
}

describe('Agent Team setup state machine', () => {
  it('persists enabled intent, progress, and ready completion', async () => {
    let time = 100;
    const { registry, control, deploymentId } = await createDeployment({
      now: () => ++time,
    });

    await expect(
      registry.enableDeployment(deploymentId),
    ).resolves.toMatchObject({
      enabled: true,
      setup: {
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

    control.emit({
      operationId: 'operation-1',
      type: 'phase',
      phase: 'installing_tools',
      status: 'started',
      message: 'Installing CLI tools',
    });
    control.emit({
      operationId: 'operation-1',
      type: 'completed',
      workingDirPath: '/teams/reviewer/workspaces/copilot',
    });

    expect(registry.getDeployment(deploymentId)).toMatchObject({
      enabled: true,
      setup: { status: 'ready' },
      setupLog: [
        {
          phase: 'installing_tools',
          status: 'started',
          message: 'Installing CLI tools',
        },
      ],
    });
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

    await expect(
      registry.enableDeployment(deploymentId),
    ).resolves.toMatchObject({
      enabled: true,
      setup: { status: 'ready' },
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
      ids: ['deployment-1', 'operation-1', 'operation-2'],
    });

    await expect(registry.enableDeployment(deploymentId)).rejects.toThrow(
      'daemon unavailable',
    );
    expect(registry.getDeployment(deploymentId)).toMatchObject({
      enabled: true,
      setup: {
        status: 'error',
        error: {
          code: 'placement_unavailable',
          message: 'daemon unavailable',
        },
      },
    });

    await expect(
      registry.retryDeploymentSetup(deploymentId),
    ).resolves.toMatchObject({
      enabled: true,
      setup: { status: 'setting_up', operationId: 'operation-2' },
    });
    control.emit({
      operationId: 'operation-2',
      type: 'completed',
      workingDirPath: '/teams/reviewer/workspaces/copilot',
    });
    expect(registry.getDeployment(deploymentId)?.setup.status).toBe('ready');
  });

  it('cancels active setup when disabled', async () => {
    const { registry, control, deploymentId } = await createDeployment();
    await registry.enableDeployment(deploymentId);

    await expect(
      registry.disableDeployment(deploymentId),
    ).resolves.toMatchObject({
      enabled: false,
      setup: { status: 'disabled' },
    });
    expect(control.cancelAgentTeamSetup).toHaveBeenCalledWith('machine-a', {
      operationId: 'operation-1',
    });
  });

  it('accepts a terminal event that wins the cancellation race', async () => {
    const { registry, control, deploymentId } = await createDeployment();
    await registry.enableDeployment(deploymentId);
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
      registry.disableDeployment(deploymentId),
    ).resolves.toMatchObject({
      enabled: false,
      setup: { status: 'disabled' },
    });
  });

  it('blocks placement changes and deletion while setup is active', async () => {
    const { registry, deploymentId } = await createDeployment();
    await registry.enableDeployment(deploymentId);

    expect(() =>
      registry.updateDeployment(deploymentId, {
        workingDirPath: '/teams/reviewer/workspaces/other',
      }),
    ).toThrow('Disable');
    expect(() => registry.deleteDeployment(deploymentId)).toThrow('Disable');
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

    await expect(registry.enableDeployment(deploymentId)).rejects.toThrow(
      'missing required Configs: TOKEN',
    );
    expect(control.setupAgentTeam).not.toHaveBeenCalled();
    expect(registry.getDeployment(deploymentId)).toMatchObject({
      enabled: false,
      setup: { status: 'disabled' },
    });
  });

  it('keeps cancellation failures visible with disabled intent', async () => {
    const control = new FakeControlPort();
    control.cancelAgentTeamSetup.mockRejectedValueOnce(
      new Error('cancel transport failed'),
    );
    const { registry, deploymentId } = await createDeployment({ control });
    await registry.enableDeployment(deploymentId);

    await expect(registry.disableDeployment(deploymentId)).rejects.toThrow(
      'cancel transport failed',
    );
    expect(registry.getDeployment(deploymentId)).toMatchObject({
      enabled: false,
      setup: {
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
      deployments: [
        {
          id: 'deployment-1',
          alias: 'Reviewer',
          revision: 1,
          enabled: true,
          machine: 'machine-a',
          manifestPath: '/teams/reviewer/agentlet.yaml',
          harness: 'copilot',
          workingDirPath: '/teams/reviewer/workspaces/copilot',
          setup: {
            status: 'setting_up',
            operationId: 'operation-1',
            startedAt: 50,
          },
          setupLog: [],
        },
      ],
    };
    const store = new InMemoryAgentTeamRegistryStore(state);

    const registry = new AgentTeamRegistry(
      store,
      new FakeControlPort(),
      () => 100,
    );

    expect(registry.getDeployment('deployment-1')).toMatchObject({
      enabled: true,
      setup: {
        status: 'error',
        failedAt: 100,
        error: { code: 'setup_interrupted' },
      },
    });
    expect(store.load()).toEqual({
      ...state,
      deployments: [
        expect.objectContaining({
          setup: expect.objectContaining({
            status: 'error',
            error: expect.objectContaining({ code: 'setup_interrupted' }),
          }),
        }),
      ],
    });
  });

  it('unsubscribes from progress events on dispose', async () => {
    const { registry, control } = await createDeployment();
    expect(control.handlers.size).toBe(1);
    registry.dispose();
    expect(control.handlers.size).toBe(0);
  });
});
