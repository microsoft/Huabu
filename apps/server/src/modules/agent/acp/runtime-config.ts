// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { externalAgentRuntimeConfigSchema } from '@huabu/shared';

import { getLogger } from '../../../utils/logger.js';
import { settingsRecordKey } from '../../identity/personal-settings.js';
import { getServerRecords } from '../../storage/index.js';

import type { ExternalAgentRuntimeConfig } from '@huabu/shared';

export const DEFAULT_EXTERNAL_AGENT_RUNTIME_CONFIG: ExternalAgentRuntimeConfig =
  {
    idleTimeoutSecs: 600,
    maxAgents: 10,
  };

const log = getLogger('external-agent-runtime-config');

export function getExternalAgentRuntimeConfig(): ExternalAgentRuntimeConfig {
  const key = settingsRecordKey('external-agent-runtime');
  try {
    const stored = getServerRecords().get(key);
    if (stored === null) return DEFAULT_EXTERNAL_AGENT_RUNTIME_CONFIG;
    const parsed = externalAgentRuntimeConfigSchema.safeParse(stored);
    if (parsed.success) return parsed.data;
    log.warn(
      { record: key.name, issues: parsed.error.issues },
      'Invalid external-agent runtime config; using defaults',
    );
  } catch (error) {
    log.warn(
      { record: key.name, error },
      'Unreadable external-agent runtime config; using defaults',
    );
  }
  return DEFAULT_EXTERNAL_AGENT_RUNTIME_CONFIG;
}

export async function setExternalAgentRuntimeConfig(
  value: ExternalAgentRuntimeConfig,
): Promise<ExternalAgentRuntimeConfig> {
  const parsed = externalAgentRuntimeConfigSchema.parse(value);
  await getServerRecords().put(
    settingsRecordKey('external-agent-runtime'),
    parsed,
  );
  return parsed;
}
