// M5 FACTORY acceptance — the ACP driver's I9.5 factory.
//
// Proves the standard ACP driver, now produced by `acpDriverFactory`
// inside this package (relocated from the host), advertises the contract
// dispatch kind + capabilities and mints a long-lived handle keyed by
// `spec.threadId` (I9.3). A full WorkloadSpec satisfies the create input
// structurally — only `threadId` is read today.

import { describe, expect, it } from 'vitest';

import { acpDriverFactory } from './driver.js';
import { AcpAgentHandle, ACP_CAPABILITIES } from './handle.js';

describe('acpDriverFactory (M5 FACTORY)', () => {
  it('produces a driver advertising capabilities (dispatch kind is external, set at register)', () => {
    const driver = acpDriverFactory();
    expect(driver.capabilities).toBe(ACP_CAPABILITIES);
  });

  it('create(spec) mints an AcpAgentHandle from the baked spec (I9.3)', () => {
    const driver = acpDriverFactory();
    const handle = driver.create({
      threadId: 'thr_1',
      namespace: { name: 'canvas_1', storage: { root: '/data/c1' } },
      binding: { alias: 'copilot', profileId: 'prof_1' },
    });
    expect(handle).toBeInstanceOf(AcpAgentHandle);
  });

  it('accepts a wider spec structurally (a full WorkloadSpec)', () => {
    const driver = acpDriverFactory();
    // A full WorkloadSpec-shaped object satisfies AcpCreateSpec structurally.
    const handle = driver.create({
      threadId: 'thr_2',
      kind: 'acp',
      namespace: { name: 'canvas_1', storage: { root: '/data/c1' } },
      binding: { alias: 'claude', profileId: 'prof_2' },
      cwd: '/work',
      recipe: null,
      env: { HUABU_THREAD_ID: 'thr_2' },
    });
    expect(handle).toBeInstanceOf(AcpAgentHandle);
  });
});
