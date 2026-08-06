import { describe, expect, it, vi } from 'vitest';

import {
  agentProfileDriverFactory,
  type AgentProfileWorkloadSpec,
} from './profile-driver.js';

import type { WorkloadSpec } from '@agenetes/protocol';
import type { MountedAgentDriver } from '@agenetes/runtime';

const capabilities = {
  supportedControlMessages: ['cancel' as const],
  loadSession: true,
  turnInput: 'blocking' as const,
};

const freshContext = {
  recovery: {
    authorizeHistoryLoad: async () => ({
      allowed: true as const,
      estimatedSize: 0,
    }),
  },
};

function testDelegate(
  onCreate: (spec: WorkloadSpec) => void,
): MountedAgentDriver {
  return {
    schemaVersion: 1,
    workloadTypes: ['Deployment'],
    validateSpec: (raw) => raw,
    validateState: (raw) => raw,
    initialState: () => ({}),
    create: (workload) => {
      onCreate(workload);
      return {
        capabilities,
        async *run() {
          yield* [];
        },
        async control() {
          return { ok: true };
        },
        close() {},
      };
    },
  };
}

function baseSpec(): Omit<AgentProfileWorkloadSpec['spec'], 'profile'> {
  return {
    binding: { profileId: 'profile-1', alias: 'reviewer' },
    env: { HUABU_THREAD_ID: 'thread-1', TOKEN: 'reachback' },
  };
}

async function realize(
  profile: AgentProfileWorkloadSpec['spec']['profile'],
  onCreate: (spec: WorkloadSpec) => void,
  resolveManifestRuntime = vi.fn(async () => ({ environment: {} })),
) {
  const driver = agentProfileDriverFactory({
    delegate: testDelegate(onCreate),
    delegateCapabilities: capabilities,
    ports: { resolveManifestRuntime },
  });
  const handle = driver.create(
    {
      kind: 'agent-profile',
      workloadType: 'Deployment',
      threadId: 'thread-1',
      namespace: { name: 'canvas-1', storage: { root: '/data/canvas-1' } },
      spec: { ...baseSpec(), profile },
    },
    freshContext,
  );
  for await (const _event of handle.run(null, undefined)) {
    throw new Error('Test delegate must not yield events');
  }
  return resolveManifestRuntime;
}

describe('agentProfileDriverFactory', () => {
  it('mounts runtime spec validation and delegates state validation', () => {
    const driver: MountedAgentDriver = agentProfileDriverFactory({
      delegate: testDelegate(() => {}),
      delegateCapabilities: capabilities,
      ports: { resolveManifestRuntime: vi.fn() },
    });

    expect(
      driver.validateSpec({
        ...baseSpec(),
        profile: {
          profileId: 'profile-1',
          agentletId: 'machine-a',
          workingDirPath: '/work/reviewer',
          launch: { kind: 'acp-command', command: 'reviewer --acp' },
        },
      }),
    ).toMatchObject({ binding: { alias: 'reviewer' } });
    expect(driver.initialState()).toEqual({});
    expect(() =>
      driver.validateSpec({
        ...baseSpec(),
        profile: { profileId: 'profile-1' },
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_driver_spec' }));
  });

  it('lowers command snapshots directly without manifest preflight', async () => {
    let lowered: WorkloadSpec | undefined;
    const resolveManifestRuntime = await realize(
      {
        profileId: 'profile-1',
        agentletId: 'machine-a',
        workingDirPath: '/work/reviewer',
        launch: { kind: 'acp-command', command: 'reviewer --acp' },
      },
      (spec) => {
        lowered = spec;
      },
    );

    expect(resolveManifestRuntime).not.toHaveBeenCalled();
    expect(lowered).toMatchObject({
      spec: {
        agentletId: 'machine-a',
        cwd: '/work/reviewer',
        recipe: {
          command: 'reviewer --acp',
          cwd: '/work/reviewer',
          autoRestart: true,
          alias: 'reviewer',
        },
      },
    });
  });

  it('validates manifest snapshots and merges Configs below host env', async () => {
    let lowered: WorkloadSpec | undefined;
    const snapshot: AgentProfileWorkloadSpec['spec']['profile'] = {
      profileId: 'profile-1',
      agentletId: 'machine-b',
      workingDirPath: '/work/reviewer',
      launch: {
        kind: 'agent-team-manifest',
        manifestPath: '/teams/reviewer/agentlet.yaml',
        harness: 'claude',
      },
    };
    const resolveManifestRuntime = vi.fn(async () => ({
      environment: { TOKEN: 'config', SHARED: 'member' },
    }));

    await realize(
      snapshot,
      (spec) => {
        lowered = spec;
      },
      resolveManifestRuntime,
    );

    expect(lowered).toMatchObject({
      spec: {
        agentletId: 'machine-b',
        cwd: '/work/reviewer',
      },
    });
    const loweredSpec = lowered?.spec as
      | { resolveRecipe?: () => Promise<unknown> }
      | undefined;
    if (!loweredSpec?.resolveRecipe) {
      throw new Error('Manifest Profile did not provide a recipe resolver');
    }
    const runtime = await loweredSpec.resolveRecipe();
    expect(resolveManifestRuntime).toHaveBeenCalledWith(snapshot);
    expect(runtime).toMatchObject({
      env: {
        TOKEN: 'reachback',
        SHARED: 'member',
        HUABU_THREAD_ID: 'thread-1',
      },
      recipe: {
        autoRestart: true,
        alias: 'reviewer',
        agentTeam: {
          manifestPath: '/teams/reviewer/agentlet.yaml',
          workingDirPath: '/work/reviewer',
          harness: 'claude',
        },
      },
    });
  });
});
