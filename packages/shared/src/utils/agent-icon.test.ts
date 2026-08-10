// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { getDefaultAgentIcon, readAgentIcon } from './agent-icon.js';

describe('agent icon helpers', () => {
  it('reads a valid persisted icon', () => {
    expect(
      readAgentIcon({
        id: 'profile-a',
        customData: { icon: { shape: 'diamond', color: 'red' } },
      }),
    ).toEqual({ shape: 'diamond', color: 'red' });
  });

  it('uses a stable fallback for missing or invalid icon data', () => {
    const fallback = getDefaultAgentIcon('profile-a');
    expect(fallback.shape).not.toBe('circle');
    expect(readAgentIcon({ id: 'profile-a' })).toEqual(fallback);
    expect(
      readAgentIcon({
        id: 'profile-a',
        customData: { icon: { shape: 'invalid', color: 'red' } },
      }),
    ).toEqual(fallback);
  });
});
