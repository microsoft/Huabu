// M5 FACTORY acceptance — the ACP driver's I9.5 factory.
//
// Proves the standard ACP driver, now produced by `acpDriverFactory`
// inside this package (relocated from the host), mints a long-lived handle
// keyed by `spec.threadId` (I9.3). A full WorkloadSpec satisfies the create
// input structurally — only `threadId` is read today.

import { getSupervisedAgentletId } from '@agenetes/agentlet-host';
import { describe, expect, it } from 'vitest';

import { acpDriverFactory } from './driver.js';
import {
  AcpAgentHandle,
  ACP_CAPABILITIES,
  resolveAcpAgentletId,
} from './handle.js';

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
    const explicit = {
      threadId: 'thr_explicit',
      agentletId: 'machine-b',
      namespace: { name: 'canvas_1' },
      binding: { alias: 'copilot', profileId: 'prof_1' },
    };
    const legacy = {
      threadId: 'thr_legacy',
      namespace: { name: 'canvas_1' },
      binding: { alias: 'copilot', profileId: 'prof_1' },
    };

    expect(resolveAcpAgentletId(explicit)).toBe('machine-b');
    expect(resolveAcpAgentletId(legacy)).toBe(getSupervisedAgentletId());
    expect('agentletId' in legacy).toBe(false);
  });

  it('create(spec) mints an AcpAgentHandle from the baked spec (I9.3)', () => {
    const driver = acpDriverFactory();
    const handle = driver.create(
      {
        threadId: 'thr_1',
        namespace: { name: 'canvas_1', storage: { root: '/data/c1' } },
        binding: { alias: 'copilot', profileId: 'prof_1' },
      },
      freshContext,
    );
    expect(handle).toBeInstanceOf(AcpAgentHandle);
    expect(handle.capabilities).toBe(ACP_CAPABILITIES);
  });

  it('accepts a wider spec structurally (a full WorkloadSpec)', () => {
    const driver = acpDriverFactory();
    // A full WorkloadSpec-shaped object satisfies AcpCreateSpec structurally.
    const handle = driver.create(
      {
        threadId: 'thr_2',
        kind: 'acp',
        namespace: { name: 'canvas_1', storage: { root: '/data/c1' } },
        binding: { alias: 'claude', profileId: 'prof_2' },
        cwd: '/work',
        recipe: null,
        env: { HUABU_THREAD_ID: 'thr_2' },
      },
      freshContext,
    );
    expect(handle).toBeInstanceOf(AcpAgentHandle);
  });
});
