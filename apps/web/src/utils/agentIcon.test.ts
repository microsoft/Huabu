// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { randomAgentIcon, snapshotAgentIcon } from './agentIcon';

describe('snapshotAgentIcon', () => {
  it('captures the saved icon for an external Profile', () => {
    expect(
      snapshotAgentIcon(
        { kind: 'external', profileId: 'profile-1', alias: 'Reviewer' },
        [
          {
            id: 'profile-1',
            customData: { icon: { shape: 'diamond', color: 'red' } },
          },
        ],
      ),
    ).toEqual({ shape: 'diamond', color: 'red' });
  });

  it('does not snapshot an icon for the built-in agent', () => {
    expect(snapshotAgentIcon({ kind: 'internal' }, [])).toBeUndefined();
  });

  it('captures a saved harness logo with its shape fallback', () => {
    expect(
      snapshotAgentIcon(
        { kind: 'external', profileId: 'profile-1', alias: 'Reviewer' },
        [
          {
            id: 'profile-1',
            customData: {
              icon: { shape: 'diamond', color: 'red', brand: 'claude' },
            },
          },
        ],
      ),
    ).toEqual({ shape: 'diamond', color: 'red', brand: 'claude' });
  });
});

describe('randomAgentIcon', () => {
  it('starts a harness with a bundled logo on that logo', () => {
    expect(randomAgentIcon('claude').brand).toBe('claude');
  });

  it('starts other agents on a shape avatar', () => {
    expect(randomAgentIcon('custom')).not.toHaveProperty('brand');
    expect(randomAgentIcon()).not.toHaveProperty('brand');
  });
});
