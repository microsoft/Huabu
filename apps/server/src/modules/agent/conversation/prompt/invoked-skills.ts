// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `<invoked_skills>` section renderer.
 *
 * Inlines the full body of every skill the user explicitly invoked this
 * turn. Distinct from the on-demand skill catalogue the model may
 * `read()` itself — these are authoritative for the current turn, so
 * the body is embedded rather than referenced.
 *
 * Output shape:
 *
 *   <invoked_skills>
 *   The user explicitly invoked the "code-review" skill. Apply its guidance to this turn.
 *   <skill id="code-review" name="Code Review">
 *   …full skill body…
 *   </skill>
 *   </invoked_skills>
 *
 * Returns `undefined` when the turn invoked no skills. The intro is
 * singular / plural depending on how many were invoked.
 */

import type { ResolvedSkill } from '../envelope.js';

/**
 * Render the `<invoked_skills>` block, or `undefined` when the turn
 * invoked none.
 */
export function renderInvokedSkillsSection(
  skills: readonly ResolvedSkill[],
): string | undefined {
  if (skills.length === 0) return undefined;
  const quotedIds = skills.map((s) => `"${s.id}"`).join(', ');
  const intro =
    skills.length === 1
      ? `The user explicitly invoked the ${quotedIds} skill. Apply its guidance to this turn.`
      : `The user explicitly invoked the ${quotedIds} skills. Apply their guidance to this turn.`;
  const skillTags = skills
    .map(
      (s) =>
        `<skill id="${s.id}" name="${s.name}">\n${s.body.trimEnd()}\n</skill>`,
    )
    .join('\n');
  return ['<invoked_skills>', intro, skillTags, '</invoked_skills>'].join('\n');
}
