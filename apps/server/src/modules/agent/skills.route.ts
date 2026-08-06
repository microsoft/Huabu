// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Skills route — exposes the user-invokable skill catalogue.
 *
 * Mounted at `/api/skills`. Backs the slash-command typeahead in the
 * web chat input for internal (built-in agent) bindings.
 *
 * Listing rule:
 *  - `user` / `merged` skills are always listed (anything the user
 *    authored or extended).
 *  - `system` skills are listed **only** when their frontmatter sets
 *    `userInvokable: true`. Reserved for system skills that are
 *    essentially user-facing commands (e.g. `create-skill`,
 *    `update-skill`). The default `false` keeps the bulk of shipped
 *    skills catalogue-only — they remain in `{{skillCatalogue}}`
 *    for autonomous use, but stay out of the `/` menu.
 *
 * Server-side filtering is the source of truth — the client mirrors
 * the same cut for UX, but `invokedSkills` is re-validated on the
 * agent route so a stale or hand-crafted client cannot force a
 * non-invokable system skill body into a turn.
 */

import {
  skillsListQuerySchema,
  type SkillCatalogueEntry,
  type SkillsListResponse,
} from '@huabu/shared';

import { listSkills, type LoadedSkill } from '../../prompt/skills/loader.js';

import type { FastifyPluginAsync } from 'fastify';

/**
 * Shared visibility predicate — the single source of truth for
 * "should this skill be invokable via `/`". Re-exported so the
 * agent route's `invokedSkills` whitelist applies the same rule
 * and a stale client cannot smuggle a non-invokable skill body
 * into a turn.
 */
export function isUserInvokableSkill(skill: LoadedSkill): boolean {
  if (skill.source === 'user' || skill.source === 'merged') return true;
  return skill.source === 'system' && skill.userInvokable === true;
}

const skillsRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/skills?scope=ask|operate|sketch|external
  app.get<{
    Querystring: { scope?: string };
    Reply: SkillsListResponse | { message: string };
  }>('/', async (request, reply) => {
    const parsed = skillsListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({
        message:
          parsed.error.issues[0]?.message ?? 'Invalid skills query parameters',
      });
    }

    const all = listSkills(parsed.data.scope);
    const userVisible = all.filter(isUserInvokableSkill);

    const skills: SkillCatalogueEntry[] = userVisible.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      source: s.source,
      appliesTo: s.appliesTo,
      ...(s.triggers ? { triggers: s.triggers } : {}),
      ...(s.version !== undefined ? { version: s.version } : {}),
    }));

    return { skills };
  });
};

export default skillsRoutes;
