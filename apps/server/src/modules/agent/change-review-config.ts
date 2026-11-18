// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { agentChangeReviewConfigSchema } from '@huabu/shared';

import { getLogger } from '../../utils/logger.js';
import { settingsRecordKey } from '../identity/personal-settings.js';
import { getServerRecords } from '../storage/index.js';

import type { AgentChangeReviewConfig } from '@huabu/shared';

export const DEFAULT_AGENT_CHANGE_REVIEW_CONFIG: AgentChangeReviewConfig = {
  autoAcceptSpaceChanges: false,
};

const log = getLogger('agent-change-review-config');

export function getAgentChangeReviewConfig(): AgentChangeReviewConfig {
  const key = settingsRecordKey('change-review');
  try {
    const stored = getServerRecords().get(key);
    if (stored === null) return DEFAULT_AGENT_CHANGE_REVIEW_CONFIG;
    const parsed = agentChangeReviewConfigSchema.safeParse(stored);
    if (parsed.success) return parsed.data;
    log.warn(
      { record: key.name, issues: parsed.error.issues },
      'Invalid Agent change-review config; using defaults',
    );
  } catch (error) {
    log.warn(
      { record: key.name, error },
      'Unreadable Agent change-review config; using defaults',
    );
  }
  return DEFAULT_AGENT_CHANGE_REVIEW_CONFIG;
}

export async function setAgentChangeReviewConfig(
  value: AgentChangeReviewConfig,
): Promise<AgentChangeReviewConfig> {
  const parsed = agentChangeReviewConfigSchema.parse(value);
  await getServerRecords().put(settingsRecordKey('change-review'), parsed);
  return parsed;
}
