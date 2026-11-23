// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Skill / prompt delivery for the RFS (`GET /api/rfs/:canvasId/skill*`).
 *
 * Resolver: return the bundled HTTP or CLI root guide followed by live Space
 * Skill Frames. The served guide is the single source of truth for how an
 * external agent reaches back into the canvas.
 */

import { renderPromptFile } from '../../prompt/agents/loader.js';
import { getLogger } from '../../utils/logger.js';
import { resolveSpaceSkill } from '../agent/space-instruction-frames.js';

import type { RfsSkillClient } from '@huabu/shared';

const logger = getLogger('rfs-skill');

const FOCUSED_SKILLS = {
  http: ['agents', 'interactive-views', 'layout', 'services', 'tasks'],
  'rfs-cli': ['agents', 'layout', 'services'],
} as const;

function clientDirectory(client: RfsSkillClient) {
  return client === 'http' ? 'http-native' : client;
}

/** Resolve the public root guide without consulting Canvas storage. */
export function resolveBundledRootSkill(client: RfsSkillClient): string {
  return renderPromptFile(
    `external-agent/${clientDirectory(client)}/access-huabu.md`,
  );
}

/**
 * Resolve the canvas-access guide for `canvasId`: the bundled default followed
 * by live Skill Frames. Returned as raw markdown text.
 */
export async function resolveCanvasSkill(
  canvasId: string,
  client: RfsSkillClient,
): Promise<string> {
  const frameSkill = await resolveSpaceSkill(canvasId, {
    includeFile: false,
  }).catch((error: unknown) => {
    logger.warn(
      { err: error, canvasId },
      'Space Skill Frame collection failed; serving the root guide only',
    );
    return null;
  });
  const guide = resolveBundledRootSkill(client);
  return frameSkill ? `${guide}\n\n${frameSkill.markdown}` : guide;
}

/** Resolve one fixed, authenticated advanced guide. */
export function resolveFocusedSkill(
  skillId: string,
  client: RfsSkillClient,
): string | null {
  if (!(FOCUSED_SKILLS[client] as readonly string[]).includes(skillId))
    return null;
  return renderPromptFile(
    `external-agent/${clientDirectory(client)}/${skillId}.md`,
  );
}
