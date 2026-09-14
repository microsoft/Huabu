// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { agentChangeReviewConfigSchema } from '@huabu/shared';

import { getDataDir } from '../../data-dir.js';
import { atomicWriteJson } from '../../utils/fs.js';
import { getLogger } from '../../utils/logger.js';

import type { AgentChangeReviewConfig } from '@huabu/shared';

export const DEFAULT_AGENT_CHANGE_REVIEW_CONFIG: AgentChangeReviewConfig = {
  autoAcceptSpaceChanges: false,
};

const log = getLogger('agent-change-review-config');

function configPath(): string {
  return join(getDataDir(), 'agent-change-review-config.json');
}

export function getAgentChangeReviewConfig(): AgentChangeReviewConfig {
  const path = configPath();
  if (!existsSync(path)) return DEFAULT_AGENT_CHANGE_REVIEW_CONFIG;

  try {
    const parsed = agentChangeReviewConfigSchema.safeParse(
      JSON.parse(readFileSync(path, 'utf8')),
    );
    if (parsed.success) return parsed.data;
    log.warn(
      { path, issues: parsed.error.issues },
      'Invalid Agent change-review config; using defaults',
    );
  } catch (error) {
    log.warn(
      { path, error },
      'Unreadable Agent change-review config; using defaults',
    );
  }
  return DEFAULT_AGENT_CHANGE_REVIEW_CONFIG;
}

export function setAgentChangeReviewConfig(
  value: AgentChangeReviewConfig,
): AgentChangeReviewConfig {
  const parsed = agentChangeReviewConfigSchema.parse(value);
  atomicWriteJson(configPath(), parsed);
  return parsed;
}
