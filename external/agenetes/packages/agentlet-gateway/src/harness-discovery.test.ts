import { describe, expect, it } from 'vitest';

import { parseHarnessDiscoveryResult } from './harness-discovery.js';

const entry = {
  id: 'copilot',
  displayName: 'Copilot',
  binary: 'copilot',
  acpArgs: ['--acp'],
  autoApprove: { args: ['--allow-all'], position: 'before-acp' },
  installHint: 'Install from upstream',
  installed: true,
  executablePath: '/bin/copilot',
  workingDirPath: '/work/copilot',
  version: '1',
  diagnostics: [{ code: 'probe', message: 'Observation' }],
};
describe('discovery response validation', () => {
  it('preserves optional structured launch opt-in without assuming it for older daemons', () => {
    expect(
      parseHarnessDiscoveryResult({
        harnesses: [{ ...entry, launchVersion: 1 }],
      }).harnesses[0],
    ).toHaveProperty('launchVersion', 1);
    expect(
      parseHarnessDiscoveryResult({ harnesses: [entry] }).harnesses[0],
    ).not.toHaveProperty('launchVersion');
    for (const launchVersion of [0, 2, '1', null]) {
      expect(() =>
        parseHarnessDiscoveryResult({
          harnesses: [{ ...entry, launchVersion }],
        }),
      ).toThrow();
    }
  });
  it('preserves every supported response field', () => {
    expect(parseHarnessDiscoveryResult({ harnesses: [entry] })).toEqual({
      harnesses: [entry],
    });
  });
  it('retains ACP capability evidence when present without requiring it from older daemons', () => {
    const capabilities = {
      autoApprove: 'supported',
      modelOverride: 'unknown',
      sessionPersistence: 'unknown',
    };
    expect(
      parseHarnessDiscoveryResult({ harnesses: [{ ...entry, capabilities }] })
        .harnesses[0],
    ).toMatchObject({ capabilities });
    expect(
      parseHarnessDiscoveryResult({ harnesses: [entry] }).harnesses[0],
    ).not.toHaveProperty('capabilities');
  });
  it.each([
    { ...entry, installed: 'true' },
    { ...entry, acpArgs: [1] },
    { ...entry, workingDirPath: false },
    { ...entry, diagnostics: [null] },
    { ...entry, autoApprove: { args: [], position: 'unknown' } },
    { ...entry, autoApprove: undefined },
    {
      ...entry,
      capabilities: {
        autoApprove: true,
        modelOverride: 'unknown',
        sessionPersistence: 'unknown',
      },
    },
    { ...entry, capabilities: { autoApprove: 'supported' } },
  ])('rejects invalid fields', (invalid) => {
    expect(() => parseHarnessDiscoveryResult({ harnesses: [invalid] })).toThrow(
      expect.objectContaining({ code: 'invalid_harness_discovery_response' }),
    );
  });
  it('rejects duplicate IDs', () => {
    expect(() =>
      parseHarnessDiscoveryResult({ harnesses: [entry, entry] }),
    ).toThrow();
  });
});
