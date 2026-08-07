// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  UTILITY_SKILL_IDS,
  modelRoleForInvokedSkills,
  planSkillDispatch,
} from './skill-model-routing.js';
import { listSkills } from '../../prompt/index.js';

describe('modelRoleForInvokedSkills', () => {
  it.each(['create-skill', 'update-skill'])(
    'routes %s through Utility',
    (id) => {
      expect(modelRoleForInvokedSkills([{ id }])).toBe('skill');
    },
  );

  it('keeps ordinary task Skills on Chat', () => {
    expect(modelRoleForInvokedSkills([{ id: 'research-comparison' }])).toBe(
      'chat',
    );
  });

  it('keeps turns without an invoked Skill on Chat', () => {
    expect(modelRoleForInvokedSkills([])).toBe('chat');
  });
});

describe('planSkillDispatch', () => {
  it('runs Skill authoring as a fresh Utility Job and closes the live handle', () => {
    expect(planSkillDispatch([{ id: 'create-skill' }])).toEqual({
      modelRole: 'skill',
      workloadType: 'Job',
      closeLiveHandle: true,
    });
  });

  it('keeps ordinary Skills on the long-lived Chat Deployment', () => {
    expect(planSkillDispatch([{ id: 'research-comparison' }])).toEqual({
      modelRole: 'chat',
      workloadType: 'Deployment',
      closeLiveHandle: false,
    });
  });

  it('keeps turns without a Skill on the Chat Deployment', () => {
    expect(planSkillDispatch([])).toEqual({
      modelRole: 'chat',
      workloadType: 'Deployment',
      closeLiveHandle: false,
    });
  });
});

describe('UTILITY_SKILL_IDS drift guard', () => {
  // The set is hardcoded, but each id must still map to a real system
  // skill that is `userInvokable: true` — the canonical source of truth.
  // Renaming an authoring skill directory (or dropping its userInvokable
  // flag) without updating the set would silently downgrade authoring to
  // Chat, since only user-invokable skills survive into `resolved`. Fail
  // loudly here instead.
  it('every id resolves to a shipped, user-invokable system skill', () => {
    const invokable = new Set(
      listSkills()
        .filter((skill) => skill.userInvokable === true)
        .map((skill) => skill.id),
    );
    for (const id of UTILITY_SKILL_IDS) {
      expect(invokable.has(id)).toBe(true);
    }
  });
});
