import { describe, expect, it } from 'vitest';

import { parseHarnessDiscoveryResult } from './harness-discovery.js';

const entry = {
  id: 'copilot',
  displayName: 'Copilot',
  installHint: 'Install from upstream',
  capabilities: {
    autoApprove: true,
    customLaunchCommand: false,
  },
  status: 'ready',
  workingDirPath: '/work/copilot',
  version: '1',
  diagnostics: [{ code: 'probe', message: 'Observation' }],
};

describe('discovery response validation', () => {
  it('preserves every supported response field', () => {
    expect(parseHarnessDiscoveryResult({ harnesses: [entry] })).toEqual({
      harnesses: [entry],
    });
  });

  it.each([
    { ...entry, status: 'unknown' },
    { ...entry, status: undefined },
    { ...entry, workingDirPath: false },
    { ...entry, diagnostics: [null] },
    { ...entry, capabilities: undefined },
    {
      ...entry,
      capabilities: { autoApprove: 'yes', customLaunchCommand: false },
    },
    { ...entry, capabilities: { autoApprove: true } },
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
