// M5 FACTORY acceptance — the ACP driver's I9.5 factory.
//
// Proves the standard ACP driver, now produced by `acpDriverFactory`
// inside this package (relocated from the host), mints a long-lived handle
// keyed by `workload.threadId` (I9.3). The driver payload is nested under
// `workload.spec` and validated by the mounted driver.

import { getSupervisedAgentletId } from '@agenetes/agentlet-host';
import { describe, expect, it } from 'vitest';

import { acpDriverFactory } from './driver.js';
import {
  AcpAgentHandle,
  ACP_CAPABILITIES,
  resolveAcpAgentletId,
  resolveAcpRuntimeLaunch,
} from './handle.js';

import type { AcpCreateSpec } from './handle.js';
import type { MountedAgentDriver } from '@agenetes/runtime';

const freshContext = {
  recovery: {
    authorizeHistoryLoad: async () => ({
      allowed: true as const,
      estimatedSize: 0,
    }),
  },
};

describe('acpDriverFactory (M5 FACTORY)', () => {
  it('preserves explicit placement and resolves legacy specs without mutation', () => {
    const explicit: AcpCreateSpec = {
      kind: 'acp',
      workloadType: 'Deployment',
      threadId: 'thr_explicit',
      namespace: { name: 'canvas_1' },
      spec: {
        agentletId: 'machine-b',
        binding: { alias: 'copilot', profileId: 'prof_1' },
      },
    };
    const legacy: AcpCreateSpec = {
      kind: 'acp',
      workloadType: 'Deployment',
      threadId: 'thr_legacy',
      namespace: { name: 'canvas_1' },
      spec: { binding: { alias: 'copilot', profileId: 'prof_1' } },
    };

    expect(resolveAcpAgentletId(explicit)).toBe('machine-b');
    expect(resolveAcpAgentletId(legacy)).toBe(getSupervisedAgentletId());
    expect('agentletId' in legacy.spec).toBe(false);
  });

  it('create(spec) mints an AcpAgentHandle from the baked spec (I9.3)', () => {
    const driver: MountedAgentDriver = acpDriverFactory();
    const handle = driver.create(
      {
        kind: 'acp',
        workloadType: 'Deployment',
        threadId: 'thr_1',
        namespace: { name: 'canvas_1', storage: { root: '/data/c1' } },
        spec: { binding: { alias: 'copilot', profileId: 'prof_1' } },
      },
      freshContext,
    );
    expect(handle).toBeInstanceOf(AcpAgentHandle);
    expect(handle.capabilities).toBe(ACP_CAPABILITIES);
  });

  it('validates the nested driver spec and durable state at runtime', () => {
    const driver: MountedAgentDriver = acpDriverFactory();
    expect(
      driver.validateSpec({
        binding: { alias: 'claude', profileId: 'prof_2' },
        initialPreferences: {
          model: 'claude-opus',
          thoughtLevel: 'high',
        },
        cwd: '/work',
        recipe: null,
        env: { HUABU_THREAD_ID: 'thr_2' },
      }),
    ).toMatchObject({
      binding: { alias: 'claude' },
      initialPreferences: {
        model: 'claude-opus',
        thoughtLevel: 'high',
      },
      cwd: '/work',
    });
    expect(driver.initialState()).toEqual({
      initialPreambleDelivered: false,
    });
    expect(() => driver.validateState({})).toThrowError(
      expect.objectContaining({ code: 'invalid_driver_state' }),
    );
    expect(() =>
      driver.validateSpec({ binding: { alias: 'claude' } }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_driver_spec' }));
    expect(() =>
      driver.validateSpec({
        binding: { alias: 'claude', profileId: 'prof_2' },
        initialPreferences: { allowAll: true },
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_driver_spec' }));

    const handle = driver.create(
      {
        kind: 'acp',
        workloadType: 'Deployment',
        threadId: 'thr_2',
        namespace: { name: 'canvas_1', storage: { root: '/data/c1' } },
        spec: {
          binding: { alias: 'claude', profileId: 'prof_2' },
          cwd: '/work',
          recipe: null,
          env: { HUABU_THREAD_ID: 'thr_2' },
        },
      },
      freshContext,
    );
    expect(handle).toBeInstanceOf(AcpAgentHandle);
  });

  it('resolves secret-backed runtime env without placing it in the durable spec', async () => {
    const spec: AcpCreateSpec['spec'] = {
      binding: { alias: 'team', profileId: 'profile-1' },
      recipe: {
        command: 'agent --acp',
        autoRestart: true,
        alias: 'team',
      },
      env: { HUABU_THREAD_ID: 'thread-1', SHARED: 'host' },
    };
    const launch = await resolveAcpRuntimeLaunch(spec, {
      getIdleTimeoutSecs: () => 600,
      resolveRuntimeEnvironment: async (received) => {
        expect(received).toBe(spec);
        return { SECRET_CONFIG: 'secret', SHARED: 'runtime' };
      },
    });

    expect(spec.env).not.toHaveProperty('SECRET_CONFIG');
    expect(launch.env).toEqual({
      SECRET_CONFIG: 'secret',
      SHARED: 'host',
      HUABU_THREAD_ID: 'thread-1',
    });
  });
});
