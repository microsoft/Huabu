// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Skill catalogue wire types.
 *
 * Exposed by `GET /api/skills` so the web chat's slash typeahead can
 * advertise the **user-authored** skill set (system skills are deliberately
 * excluded from the menu — they remain in the agent's `{{skillCatalogue}}`
 * but are not user-invokable via `/`).
 *
 * Per docs/architecture/api-design.md the schema lives here and is the single source
 * of truth; the server validates with it, the web bundle imports the
 * derived type via `import type` only.
 */

import { z } from 'zod';

/** Agent surfaces a skill is intended for. Mirrors `SkillScope` on the server. */
export const skillScopeSchema = z.enum(['ask', 'operate', 'external']);
export type SkillScope = z.infer<typeof skillScopeSchema>;

/** Where a skill came from on disk. Mirrors `SkillSource` on the server. */
export const skillSourceSchema = z.enum(['system', 'user', 'merged']);
export type SkillSource = z.infer<typeof skillSourceSchema>;

/**
 * Compact catalogue entry returned by `GET /api/skills`.
 *
 * Field surface is intentionally a subset of the server's `LoadedSkill`:
 * the body and `sourcePath` stay on the server — only metadata the
 * typeahead actually renders crosses the wire.
 */
export const skillCatalogueEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  source: skillSourceSchema,
  appliesTo: z.array(skillScopeSchema).min(1),
  triggers: z.array(z.string()).optional(),
  version: z.number().optional(),
});
export type SkillCatalogueEntry = z.infer<typeof skillCatalogueEntrySchema>;

/** Querystring for `GET /api/skills`. */
export const skillsListQuerySchema = z.object({
  /** Filter to skills whose `appliesTo` includes this surface. */
  scope: skillScopeSchema.optional(),
});
export type SkillsListQuery = z.infer<typeof skillsListQuerySchema>;

/** Response body for `GET /api/skills`. */
export const skillsListResponseSchema = z.object({
  skills: z.array(skillCatalogueEntrySchema),
});
export type SkillsListResponse = z.infer<typeof skillsListResponseSchema>;
