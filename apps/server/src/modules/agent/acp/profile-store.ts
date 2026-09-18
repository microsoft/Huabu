// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { acpAgentProfileSchema } from '@huabu/shared';

import { getDataDir } from '../../../data-dir.js';
import { logger } from '../../../utils/logger.js';

import type { AcpAgentProfile } from '@huabu/shared';

/** Read the pre-registry command data once during migration; never rewrite it. */
export function listProfiles(): AcpAgentProfile[] {
  let text: string;
  try {
    text = readFileSync(join(getDataDir(), 'agent-profiles.json'), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const file: unknown = JSON.parse(text);
  if (
    !file ||
    typeof file !== 'object' ||
    !('schemaVersion' in file) ||
    file.schemaVersion !== 1 ||
    !('profiles' in file) ||
    !Array.isArray(file.profiles)
  ) {
    throw new Error('Unsupported legacy command Profile file');
  }

  const profiles: AcpAgentProfile[] = [];
  let retired = 0;
  for (const raw of file.profiles) {
    if (
      raw &&
      typeof raw === 'object' &&
      (raw.cliId === 'agent-team' ||
        Object.prototype.hasOwnProperty.call(raw, 'agentTeam'))
    ) {
      retired += 1;
      continue;
    }
    const parsed = acpAgentProfileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `Invalid legacy command Profile: ${parsed.error.message}`,
      );
    }
    profiles.push(parsed.data);
  }
  if (retired) {
    logger.warn(
      { retired },
      '[acp] legacy Agent Team records retained as data only',
    );
  }
  return profiles.sort((left, right) => left.createdAt - right.createdAt);
}
