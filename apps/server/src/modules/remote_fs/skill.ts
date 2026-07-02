/**
 * Skill / prompt delivery for the RFS (`GET /api/rfs/:canvasId/skill`).
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
  return renderPromptFile(ACCESS_GUIDE_TEMPLATE);
}
