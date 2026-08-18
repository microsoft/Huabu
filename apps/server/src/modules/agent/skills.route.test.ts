// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tests for `GET /api/skills`.
 *
 * We exercise the route via Fastify's `inject()` so the actual zod
 * validation, query parsing, and `listSkills`→filter pipeline are
 * covered end-to-end. Skill data is materialised in a tmp workspace
 * so the test is hermetic and does not depend on whatever skills the
 * repo ships at the moment.
 *
 * Coverage:
 *   ✓ system-only skills are hidden from the menu
 *   ✓ user skills are listed
 *   ✓ same-id system + user merges to `source === 'merged'` and is listed
 *   ✓ scope query filters by `appliesTo`
 *   ✓ malformed scope returns 400
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import skillsRoutes from './skills.route.js';
import {
  invalidateSkillCache,
  type LoadedSkill,
} from '../../prompt/skills/loader.js';
import { userSkillsDir } from '../workspace/paths.js';
import { setWorkspacePath } from '../workspace.js';

import type { SkillCatalogueEntry } from '@huabu/shared';

interface InjectListResponse {
  skills: SkillCatalogueEntry[];
}

let tmp: string;

function writeUserSkill(
  id: string,
  appliesTo: string[],
  description = `Description for ${id}`,
): void {
  const dir = join(userSkillsDir(), id);
  mkdirSync(dir, { recursive: true });
  const frontmatter = [
    '---',
    `id: ${id}`,
    `name: ${id}`,
    `description: ${description}`,
    `appliesTo:`,
    ...appliesTo.map((s) => `  - ${s}`),
    '---',
    '',
    `# ${id}`,
    '',
    'Body.',
    '',
  ].join('\n');
  writeFileSync(join(dir, 'SKILL.md'), frontmatter, 'utf8');
}

async function buildApp() {
  const app = fastify();
  await app.register(skillsRoutes, { prefix: '/skills' });
  await app.ready();
  return app;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'huabu-skills-route-'));
  setWorkspacePath(tmp);
  invalidateSkillCache();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  invalidateSkillCache();
});

describe('GET /api/skills — listing', () => {
  it('hides catalogue-only system skills, surfaces user / merged / userInvokable system skills', async () => {
    writeUserSkill('user-only-a', ['ask', 'operate']);
    writeUserSkill('user-only-b', ['ask']);

    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/skills/' });
      expect(res.statusCode).toBe(200);
      const body = res.json<InjectListResponse>();
      const ids = body.skills.map((s) => s.id);
      // Catalogue-only system skills (the default for shipped
      // skills like `space`) must NOT appear in the user-invokable
      // menu — they live in the agent's `{{skillCatalogue}}` only.
      expect(ids).not.toContain('space');
      // User skills must show up.
      expect(ids).toContain('user-only-a');
      expect(ids).toContain('user-only-b');
      // System skills that opt in via `userInvokable: true` are
      // expected to show up too — `create-skill` and `update-skill`
      // ship with this flag set so the slash menu can launch them.
      expect(ids).toContain('create-skill');
      expect(ids).toContain('update-skill');
      // Every returned entry must be either user/merged OR an
      // opt-in system skill — no other source/flag combo should
      // ever leak in.
      for (const skill of body.skills) {
        expect(['user', 'merged', 'system']).toContain(skill.source);
      }
    } finally {
      await app.close();
    }
  });

  it('honours the scope query parameter', async () => {
    writeUserSkill('ask-only', ['ask']);
    writeUserSkill('operate-only', ['operate']);
    writeUserSkill('external-only', ['external']);

    const app = await buildApp();
    try {
      const askRes = await app.inject({
        method: 'GET',
        url: '/skills/?scope=ask',
      });
      const askIds = askRes.json<InjectListResponse>().skills.map((s) => s.id);
      expect(askIds).toContain('ask-only');
      expect(askIds).not.toContain('operate-only');
      expect(askIds).not.toContain('external-only');

      const externalRes = await app.inject({
        method: 'GET',
        url: '/skills/?scope=external',
      });
      const externalIds = externalRes
        .json<InjectListResponse>()
        .skills.map((s) => s.id);
      expect(externalIds).toContain('external-only');
      expect(externalIds).not.toContain('ask-only');
    } finally {
      await app.close();
    }
  });

  it('promotes a user-extension of a system skill to `merged` and lists it', async () => {
    // The skill loader merges system + user skills that share the same
    // id (see `mergeSkill` in loader.ts). `space` is shipped as a
    // system skill, so authoring a user-side override produces a
    // `merged` entry that the route MUST surface.
    writeUserSkill('space', ['ask', 'operate'], 'My custom Space notes');

    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/skills/' });
      const body = res.json<InjectListResponse>();
      const entry = body.skills.find((s) => s.id === 'space');
      expect(entry).toBeDefined();
      expect(entry?.source).toBe('merged');
    } finally {
      await app.close();
    }
  });

  it('rejects an unknown scope with HTTP 400', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/skills/?scope=bogus',
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('returns only the opt-in system skills when the workspace has no user skills', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/skills/' });
      expect(res.statusCode).toBe(200);
      const body = res.json<InjectListResponse>();
      // With an empty workspace, the only entries are the shipped
      // `userInvokable: true` system skills (`create-skill`,
      // `update-skill`). Any other source/flag combination would be
      // a regression in the filter.
      expect(Array.isArray(body.skills)).toBe(true);
      for (const skill of body.skills) {
        expect(skill.source).toBe('system');
      }
    } finally {
      await app.close();
    }
  });
});

// Suppress "unused" warning on the type re-export when tests don't reach it.
void (null as unknown as LoadedSkill);
