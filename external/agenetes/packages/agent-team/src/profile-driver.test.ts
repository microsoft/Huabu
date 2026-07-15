import { describe, expect, it, vi } from 'vitest';

import {
  agentProfileDriverFactory,
  type AgentProfileDelegateWorkloadSpec,
  type AgentProfileWorkloadSpec,
} from './profile-driver.js';

import type { AgentDriver } from '@agenetes/runtime';

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
  onCreate: (spec: AgentProfileDelegateWorkloadSpec) => void,
): AgentDriver<AgentProfileDelegateWorkloadSpec> {
  return {
    create: (spec) => {
      onCreate(spec);
      return {
        capabilities,
        async *run() {
          return undefined;
        },
        async control() {
          return { ok: true };
        },
        close() {},
      };
    },
  };
}

function baseSpec(): Omit<AgentProfileWorkloadSpec, 'profile'> {
  return {
    threadId: 'thread-1',
    namespace: { name: 'canvas-1', storage: { root: '/data/canvas-1' } },
    binding: { profileId: 'profile-1', alias: 'reviewer' },
    env: { HUABU_THREAD_ID: 'thread-1', TOKEN: 'reachback' },
  };
}

async function realize(
  profile: AgentProfileWorkloadSpec['profile'],
  onCreate: (spec: AgentProfileDelegateWorkloadSpec) => void,
  resolveManifestRuntime = vi.fn(async () => ({ environment: {} })),
) {
  const driver = agentProfileDriverFactory({
    delegate: testDelegate(onCreate),
    delegateCapabilities: capabilities,
    ports: { resolveManifestRuntime },
  });
  const handle = driver.create({ ...baseSpec(), profile }, freshContext);
  for await (const _event of handle.run(null, undefined)) {
    throw new Error('Test delegate must not yield events');
  }
  return resolveManifestRuntime;
}

describe('agentProfileDriverFactory', () => {
  it('lowers command snapshots directly without manifest preflight', async () => {
    let lowered: AgentProfileDelegateWorkloadSpec | undefined;
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
      agentletId: 'machine-a',
      cwd: '/work/reviewer',
      recipe: {
        command: 'reviewer --acp',
        cwd: '/work/reviewer',
        autoRestart: true,
        alias: 'reviewer',
      },
    });
  });

  it('validates manifest snapshots and merges Configs below host env', async () => {
    let lowered: AgentProfileDelegateWorkloadSpec | undefined;
    const snapshot: AgentProfileWorkloadSpec['profile'] = {
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
      agentletId: 'machine-b',
      cwd: '/work/reviewer',
    });
    if (!lowered || !('resolveRecipe' in lowered) || !lowered.resolveRecipe) {
      throw new Error('Manifest Profile did not provide a recipe resolver');
    }
    const runtime = await lowered.resolveRecipe();
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
