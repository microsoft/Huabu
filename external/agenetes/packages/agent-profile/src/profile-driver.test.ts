import { describe, expect, it, vi } from 'vitest';

import { agentProfileDriverFactory } from './profile-driver.js';

import type { MountedAgentDriver } from '@agenetes/runtime';

const capabilities = {
  supportedControlMessages: ['cancel' as const],
  loadSession: true,
  turnInput: 'blocking' as const,
};
const profile = {
  profileId: 'profile-1',
  agentletId: 'machine-a',
  workingDirPath: '/work',
  launch: { kind: 'acp-command' as const, command: 'agent --acp' },
};
function driver() {
  const create = vi.fn<MountedAgentDriver['create']>(() => ({
    capabilities,
    async *run() {
      yield* [];
    },
    async control() {
      return { ok: true };
    },
    close() {},
  }));
  const delegate: MountedAgentDriver = {
    schemaVersion: 1,
    workloadTypes: ['Deployment'],
    validateSpec: (raw) => raw,
    validateState: (raw) => raw,
    initialState: () => ({}),
    create,
  };
  return {
    create,
    mounted: agentProfileDriverFactory({
      delegate,
      delegateCapabilities: capabilities,
    }),
  };
}
describe('command Profile lowering', () => {
  it('forwards structured identity and ACP preferences without manufacturing a shell command', async () => {
    const { mounted, create } = driver();
    const launch = {
      kind: 'acp-harness',
      harnessId: 'copilot',
      options: { autoApprove: true },
    };
    const initialPreferences = { model: 'model with spaces; not shell syntax' };
    const spec = {
      binding: { alias: 'Typed', profileId: profile.profileId },
      profile: { ...profile, launch, executionRevision: 7 },
      initialPreferences,
    };
    expect(mounted.validateSpec(spec)).toEqual(spec);
    const handle = mounted.create(
      {
        kind: 'agent-profile',
        workloadType: 'Deployment',
        threadId: 'typed',
        namespace: { name: 'canvas' },
        spec,
      },
      {
        recovery: {
          authorizeHistoryLoad: async () => ({
            allowed: true,
            estimatedSize: 0,
          }),
        },
      },
    );
    await handle.control({ type: 'cancel', data: {} });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: expect.objectContaining({
          profileExecutionRevision: 7,
          initialPreferences,
          recipe: { launch, cwd: '/work', autoRestart: true, alias: 'Typed' },
        }),
      }),
      expect.anything(),
    );
  });

  it('preserves placement, bootstrap, environment and recovery context', async () => {
    const { mounted, create } = driver();
    const context = {
      recovery: {
        authorizeHistoryLoad: async () => ({
          allowed: true as const,
          estimatedSize: 0,
        }),
      },
    };
    const spec = {
      binding: { alias: 'Agent', profileId: profile.profileId },
      profile,
      env: { TOKEN: 'opaque' },
      initialPreamble: ['Bootstrap'],
    };
    expect(mounted.validateSpec(spec)).toEqual(spec);
    const handle = mounted.create(
      {
        kind: 'agent-profile',
        workloadType: 'Deployment',
        threadId: 'thread',
        namespace: { name: 'canvas', storage: { root: '/data' } },
        spec,
      },
      context,
    );
    await handle.control({ type: 'cancel', data: {} });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: {
          binding: spec.binding,
          agentletId: 'machine-a',
          cwd: '/work',
          env: spec.env,
          initialPreamble: spec.initialPreamble,
          recipe: {
            command: 'agent --acp',
            cwd: '/work',
            autoRestart: true,
            alias: 'Agent',
          },
        },
      }),
      context,
    );
  });
  it('rejects retired manifest snapshots', () => {
    expect(() =>
      driver().mounted.validateSpec({
        binding: { alias: 'Retired', profileId: profile.profileId },
        profile: {
          ...profile,
          launch: {
            kind: 'agent-team-manifest',
            manifestPath: '/old',
            harness: 'copilot',
          },
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_driver_spec' }));
  });
});
