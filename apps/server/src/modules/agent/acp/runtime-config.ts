import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { externalAgentRuntimeConfigSchema } from '@sediment/shared';

import { getDataDir } from '../../../data-dir.js';
import { atomicWriteJson } from '../../../utils/fs.js';
import { getLogger } from '../../../utils/logger.js';

import type { ExternalAgentRuntimeConfig } from '@sediment/shared';

export const DEFAULT_EXTERNAL_AGENT_RUNTIME_CONFIG: ExternalAgentRuntimeConfig =
  {
    idleTimeoutSecs: 600,
  };

const log = getLogger('external-agent-runtime-config');

function configPath(): string {
  return join(getDataDir(), 'external-agent-runtime-config.json');
}

export function getExternalAgentRuntimeConfig(): ExternalAgentRuntimeConfig {
  const path = configPath();
  if (!existsSync(path)) return DEFAULT_EXTERNAL_AGENT_RUNTIME_CONFIG;

  try {
    const parsed = externalAgentRuntimeConfigSchema.safeParse(
      JSON.parse(readFileSync(path, 'utf8')),
    );
    if (parsed.success) return parsed.data;
    log.warn(
      { path, issues: parsed.error.issues },
      'Invalid external-agent runtime config; using defaults',
    );
  } catch (error) {
    log.warn(
      { path, error },
      'Unreadable external-agent runtime config; using defaults',
    );
  }
  return DEFAULT_EXTERNAL_AGENT_RUNTIME_CONFIG;
}

export function setExternalAgentRuntimeConfig(
  value: ExternalAgentRuntimeConfig,
): ExternalAgentRuntimeConfig {
  const parsed = externalAgentRuntimeConfigSchema.parse(value);
  atomicWriteJson(configPath(), parsed);
  return parsed;
}
