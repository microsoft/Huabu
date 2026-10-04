// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { formatAgentletDeviceDisplayName } from './agentlet-device-display.js';

describe('formatAgentletDeviceDisplayName', () => {
  it('combines hostname and environment without exposing device identity', () => {
    expect(
      formatAgentletDeviceDisplayName({
        hostname: 'huabu',
        platform: 'linux',
        arch: 'x64',
      }),
    ).toBe('huabu: linux x64');
  });

  it('omits missing metadata and retains a non-identity fallback', () => {
    expect(formatAgentletDeviceDisplayName({ hostname: 'huabu' })).toBe(
      'huabu',
    );
    expect(
      formatAgentletDeviceDisplayName({ platform: 'linux', arch: 'arm64' }),
    ).toBe('Agentlet: linux arm64');
    expect(formatAgentletDeviceDisplayName()).toBe('Agentlet');
  });
});
