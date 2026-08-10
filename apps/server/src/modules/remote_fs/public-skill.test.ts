// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { isPublicRfsSkillBootstrapRequest } from './public-skill.js';

describe('isPublicRfsSkillBootstrapRequest', () => {
  it('allows only a credential-free root RFS skill GET', () => {
    expect(
      isPublicRfsSkillBootstrapRequest({
        method: 'GET',
        url: '/api/rfs/canvas-a/skill',
      }),
    ).toBe(true);
    expect(
      isPublicRfsSkillBootstrapRequest({
        method: 'GET',
        url: '/api/rfs/unknown/skill?refresh=1',
      }),
    ).toBe(true);
  });

  it('does not exempt invalid credentials, nested skills, or other methods', () => {
    expect(
      isPublicRfsSkillBootstrapRequest({
        method: 'GET',
        url: '/api/rfs/canvas-a/skill',
        authorization: 'Bearer invalid',
      }),
    ).toBe(false);
    expect(
      isPublicRfsSkillBootstrapRequest({
        method: 'GET',
        url: '/api/rfs/canvas-a/skill/tasks',
      }),
    ).toBe(false);
    expect(
      isPublicRfsSkillBootstrapRequest({
        method: 'POST',
        url: '/api/rfs/canvas-a/skill',
      }),
    ).toBe(false);
  });
});
