// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { resolveQuestionAgentPresentation } from './questionAgentPresentation';

describe('resolveQuestionAgentPresentation', () => {
  const binding = {
    kind: 'external' as const,
    profileId: 'profile-1',
    alias: 'Fallback alias',
  };

  it('uses the latest alias and icon while the profile exists', () => {
    expect(
      resolveQuestionAgentPresentation({
        binding,
        fallbackIcon: { shape: 'diamond', color: 'red' },
        profiles: [
          {
            id: 'profile-1',
            alias: 'Renamed agent',
            customData: { icon: { shape: 'cloud', color: 'green' } },
          },
        ],
      }),
    ).toEqual({
      kind: 'external',
      alias: 'Renamed agent',
      icon: { shape: 'cloud', color: 'green' },
    });
  });

  it('uses the bind-time snapshots after the profile is deleted', () => {
    expect(
      resolveQuestionAgentPresentation({
        binding,
        fallbackIcon: { shape: 'diamond', color: 'red' },
        profiles: [],
      }),
    ).toEqual({
      kind: 'external',
      alias: 'Fallback alias',
      icon: { shape: 'diamond', color: 'red' },
    });
  });

  it('derives a stable icon for legacy nodes without an icon snapshot', () => {
    const first = resolveQuestionAgentPresentation({ binding, profiles: [] });
    const second = resolveQuestionAgentPresentation({ binding, profiles: [] });

    expect(first.alias).toBe('Fallback alias');
    expect(first.kind).toBe('external');
    expect(second.kind).toBe('external');
    if (first.kind !== 'external' || second.kind !== 'external') return;
    expect(first.icon).toEqual(second.icon);
  });

  it('uses the canonical built-in agent presentation', () => {
    expect(
      resolveQuestionAgentPresentation({
        binding: { kind: 'internal' },
        fallbackIcon: { shape: 'diamond', color: 'red' },
        profiles: [],
      }),
    ).toEqual({ kind: 'internal', alias: 'Huabu', mode: 'ask' });
  });

  it('carries the built-in mode for the Agent (operate) face', () => {
    expect(
      resolveQuestionAgentPresentation({
        binding: { kind: 'internal' },
        profiles: [],
        agentMode: 'operate',
      }),
    ).toEqual({ kind: 'internal', alias: 'Huabu', mode: 'operate' });
  });
});
