/**
 * Skills route — exposes the user-invokable skill catalogue.
 *
 * Mounted at `/api/skills`. Backs the slash-command typeahead in the
 * web chat input for internal (built-in agent) bindings.
 *
 * Listing rule: we deliberately only surface `user` and `merged`
 * skills here. `system`-only skills are part of the agent's
 * `{{skillCatalogue}}` so the model can still pick them up on its own,
 * but they are not user-invokable via `/` because:
 *  - they would create a long, noisy menu out of skills the user did
 *    not author and may not even be aware of, and
 *  - explicit invocation has stronger force-include semantics (see the
 *    `invokedSkills` handling in agent.route.ts) that should be
 *    opt-in per user, not blanket-applied to every shipped skill.
 *
 * Server-side filtering is the source of truth — the client mirrors
 * the same `user | merged` cut for UX, but `invokedSkills` is
 * re-validated on the agent route so a stale or hand-crafted client
 * cannot force a `system` skill body into a turn.
 */

import {
  skillsListQuerySchema,
  type SkillCatalogueEntry,
  type SkillsListResponse,
} from '@sediment/shared';

import { listSkills } from '../../prompt/skills/loader.js';

import type { FastifyPluginAsync } from 'fastify';

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
    // User-authored only — see file-header rationale.
    const userVisible = all.filter(
      (s) => s.source === 'user' || s.source === 'merged',
    );

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
