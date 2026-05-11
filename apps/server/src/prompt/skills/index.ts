/**
 * Skill catalogue helper.
 *
 * The catalogue is the only piece of skill metadata that gets injected
 * into a system prompt — it tells the agent which skills exist so it
 * can decide whether to load one. Loading itself happens via
 * `read("skills/<id>/SKILL.md")`, which is wired up in
 * `tools/handlers/fs-read.ts` (per-canvas override → global SKILL.md
 * fallback). This module exists to keep the catalogue formatting
 * decoupled from the loader and the tool surface.
 */

import { listSkills, type SkillScope } from '../skill-loader.js';

/**
 * Returns a compact catalogue string for embedding in the system prompt.
 * Format: one skill per line, "- **{id}** — {description}".
 *
 * Pass `scope` to filter by agent surface (e.g. `'operate'` so the
 * operate-mode prompt doesn't list annotation-only skills).
 *
 * The catalogue is intentionally instruction-free — the prompt that
 * embeds it (see `agent.ts`, `intent.ts`) tells the agent how to load
 * a skill (`read("skills/<id>/SKILL.md")`). Keeping the loader name
 * out of the catalogue itself means we can swap loading mechanisms
 * later without re-stamping every skill line.
 */
export function getSkillCatalogue(scope?: SkillScope): string {
  const skills = listSkills(scope);
  return skills.map((s) => `- **${s.id}** — ${s.description}`).join('\n');
}
