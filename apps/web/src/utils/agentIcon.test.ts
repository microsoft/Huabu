// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { snapshotAgentIcon } from './agentIcon';

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
});
