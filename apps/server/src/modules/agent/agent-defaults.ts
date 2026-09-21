// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { agentDefaultsSchema } from '@huabu/shared';

import { getDataDir } from '../../data-dir.js';
import { atomicWriteJson } from '../../utils/fs.js';

import type { AgentDefaults, AgentProfileView } from '@huabu/shared';

export class AgentDefaultsError extends Error {
  readonly cause?: unknown;

  constructor(
    public readonly code:
      | 'default_profile_unconfigured'
      | 'agent_defaults_corrupt',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = 'AgentDefaultsError';
    this.cause = options?.cause;
  }
}

interface AgentDefaultsStorage {
  read: () => unknown;
  write: (config: AgentDefaults) => void;
}

function configPath(): string {
  return join(getDataDir(), 'agent-defaults.json');
}

const diskStorage: AgentDefaultsStorage = {
  read() {
    let text: string;
    try {
      text = readFileSync(configPath(), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new AgentDefaultsError(
        'agent_defaults_corrupt',
        'Invalid Agent defaults file: malformed JSON',
        { cause: error },
      );
    }
  },
  write: (config) => atomicWriteJson(configPath(), config),
};

export class AgentDefaultsService {
  constructor(private readonly storage: AgentDefaultsStorage = diskStorage) {}

  getAgentDefaults(): AgentDefaults {
    return this.parseDefaults(this.storage.read());
  }

  private parseDefaults(stored: unknown): AgentDefaults {
    if (stored === undefined) return { profileId: null, functionalModel: '' };
    const parsed = agentDefaultsSchema.safeParse(stored);
    if (!parsed.success) {
      throw new AgentDefaultsError(
        'agent_defaults_corrupt',
        'Invalid Agent defaults file: invalid configuration',
        { cause: parsed.error },
      );
    }
    return parsed.data;
  }

  requireDefaultAgentProfileId(): string {
    const { profileId } = this.getAgentDefaults();
    if (profileId === null) {
      throw new AgentDefaultsError(
        'default_profile_unconfigured',
        'Select a default external Agent Profile in Settings',
      );
    }
    return profileId;
  }

  setAgentDefaults(config: AgentDefaults): AgentDefaults {
    const parsed = agentDefaultsSchema.parse(config);
    this.storage.write(parsed);
    return parsed;
  }

  initializeAgentDefaults(
    profiles: readonly AgentProfileView[],
  ): AgentDefaults {
    const stored = this.storage.read();
    const current = this.parseDefaults(stored);
    if (stored !== undefined) return current;
    const candidates = profiles.filter((profile) => profile.id !== 'huabu');
    const key = (profile: AgentProfileView): string[] => [
      profile.agentletId,
      'harnessId' in profile.launch
        ? String(profile.launch.harnessId)
        : (profile.metadata?.cliId ?? ''),
      profile.id,
    ];
    candidates.sort((left, right) => {
      const a = key(left);
      const b = key(right);
      for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
      }
      return 0;
    });
    if (!candidates[0]) return current;
    return this.setAgentDefaults({ ...current, profileId: candidates[0].id });
  }
}

const service = new AgentDefaultsService();
export const getAgentDefaults = (): AgentDefaults => service.getAgentDefaults();
export const requireDefaultAgentProfileId = (): string =>
  service.requireDefaultAgentProfileId();
export const setAgentDefaults = (config: AgentDefaults): AgentDefaults =>
  service.setAgentDefaults(config);
export const initializeAgentDefaults = (
  profiles: readonly AgentProfileView[],
): AgentDefaults => service.initializeAgentDefaults(profiles);
