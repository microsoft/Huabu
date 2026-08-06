// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Skills API client.
 *
 * Thin wrapper around `GET /api/skills` (the user-invokable skill
 * catalogue). Used by `useInternalSlashCommands` to populate the
 * chat input's slash typeahead when the active thread is bound to
 * the built-in agent.
 *
 * Note on filtering: the server returns only `user` / `merged` skills
 * (system-only skills are not user-invokable via `/`). The client
 * mirrors that contract for UX, but the agent route re-validates
 * `invokedSkills` server-side — see agent.route.ts.
 */

import { apiFetch } from './_client';
import { routes } from './_routes';

import type { SkillsListResponse } from '@huabu/shared';

/**
 * Fetch the user-invokable skill catalogue, optionally scoped to one
 * agent surface.
 *
 * @param scope When set, only skills whose `appliesTo` includes the
 *   scope are returned. Pass the active chat mode (`ask` / `operate`)
 *   so the menu hides skills that don't apply to the current surface.
 */
export async function listSkills(scope?: string): Promise<SkillsListResponse> {
  return apiFetch<SkillsListResponse>(routes.skillsList(scope), {
    method: 'GET',
  });
}
