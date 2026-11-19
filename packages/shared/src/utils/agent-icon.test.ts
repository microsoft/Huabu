// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  AGENT_ICON_BRANDS,
  getDefaultAgentIcon,
  getHarnessAgentIconBrand,
  readAgentIcon,
  withHarnessAgentIconBrand,
} from './agent-icon.js';
import { agentIconSchema } from '../types/api/agent-profile.js';

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

  it('reads a persisted harness logo and keeps its shape fallback', () => {
    expect(
      readAgentIcon({
        id: 'profile-a',
        customData: {
          icon: { shape: 'diamond', color: 'red', brand: 'claude' },
        },
      }),
    ).toEqual({ shape: 'diamond', color: 'red', brand: 'claude' });
  });

  it('degrades an unknown logo to the saved shape', () => {
    expect(
      readAgentIcon({
        id: 'profile-a',
        customData: {
          icon: { shape: 'diamond', color: 'red', brand: 'from-the-future' },
        },
      }),
    ).toEqual({ shape: 'diamond', color: 'red' });
  });

  it('does not give an existing Profile without a saved icon a logo', () => {
    expect(readAgentIcon({ id: 'profile-a' })).not.toHaveProperty('brand');
  });

  it('maps a harness to its logo only when one is bundled', () => {
    expect(getHarnessAgentIconBrand('claude')).toBe('claude');
    expect(getHarnessAgentIconBrand('custom')).toBeUndefined();
    expect(getHarnessAgentIconBrand('proxy')).toBeUndefined();
    expect(getHarnessAgentIconBrand(undefined)).toBeUndefined();
  });

  it('seeds the creation default from the harness', () => {
    const shape = { shape: 'spark', color: 'blue' } as const;
    expect(withHarnessAgentIconBrand(shape, 'codex')).toEqual({
      ...shape,
      brand: 'codex',
    });
    expect(withHarnessAgentIconBrand(shape, 'custom')).toEqual(shape);
    expect(
      withHarnessAgentIconBrand({ ...shape, brand: 'claude' }, 'custom'),
    ).toEqual(shape);
  });

  it('keeps the wire schema and the brand list in sync', () => {
    for (const brand of AGENT_ICON_BRANDS) {
      expect(
        agentIconSchema.safeParse({ shape: 'spark', color: 'blue', brand })
          .success,
      ).toBe(true);
    }
    expect(agentIconSchema.shape.brand.unwrap().options).toEqual(
      AGENT_ICON_BRANDS,
    );
    expect(
      agentIconSchema.safeParse({
        shape: 'spark',
        color: 'blue',
        brand: 'unknown',
      }).success,
    ).toBe(false);
  });
});
