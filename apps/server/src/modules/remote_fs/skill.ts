// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Skill / prompt delivery for the RFS (`GET /api/rfs/:canvasId/skill*`).
 *
 * Resolver: return the **per-canvas `skill.md`** at the canvas root when
 * present (future per-canvas customization), else the **bundled default**
 * `prompt/external-agent/access-huabu.md`. The served guide is the single
 * source of truth for how an external agent reaches back into the canvas —
 * there is no pushed copy to drift from (see the proposal §6c).
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { renderPromptFile } from '../../prompt/agents/loader.js';
import { canvasRoot } from '../storage/paths.js';

/** PROMPT-ROOT-relative path of the bundled access guide. */
const ACCESS_GUIDE_TEMPLATE = 'external-agent/access-huabu.md';

const FOCUSED_SKILL_TEMPLATES = {
  layout: 'external-agent/layout.md',
  tasks: 'external-agent/tasks.md',
  agents: 'external-agent/agents.md',
  'interactive-views': 'external-agent/interactive-views.md',
} as const;

export type RfsFocusedSkillId = keyof typeof FOCUSED_SKILL_TEMPLATES;

/** Resolve the public root guide without consulting Canvas storage. */
export function resolveBundledRootSkill(): string {
  return renderPromptFile(ACCESS_GUIDE_TEMPLATE);
}

/**
 * Resolve the canvas-access guide for `canvasId`: a canvas-root `skill.md`
 * override when it exists, otherwise the bundled default. Returned as raw
 * markdown text (served with `Content-Type: text/markdown`).
 */
export function resolveCanvasSkill(canvasId: string): string {
  const override = path.join(canvasRoot(canvasId), 'skill.md');
  if (existsSync(override)) {
    return readFileSync(override, 'utf8');
  }
  return resolveBundledRootSkill();
}

/** Resolve one fixed, authenticated advanced guide. */
export function resolveFocusedSkill(skillId: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(FOCUSED_SKILL_TEMPLATES, skillId)) {
    return null;
  }
  return renderPromptFile(
    FOCUSED_SKILL_TEMPLATES[skillId as RfsFocusedSkillId],
  );
}
