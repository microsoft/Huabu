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
  it('preserves every supported response field', () => {
    expect(parseHarnessDiscoveryResult({ harnesses: [entry] })).toEqual({
      harnesses: [entry],
    });
  });
  it.each([
    { ...entry, installed: 'true' },
    { ...entry, acpArgs: [1] },
    { ...entry, workingDirPath: false },
    { ...entry, diagnostics: [null] },
    { ...entry, autoApprove: { args: [], position: 'unknown' } },
    { ...entry, autoApprove: undefined },
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
