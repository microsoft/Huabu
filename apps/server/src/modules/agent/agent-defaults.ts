// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { resolveConnectedAgentletId } from '@agenetes/agentlet-host';

import { agentDefaultsSchema } from '@huabu/shared';

import {
  personalSettingsOwner,
  settingsRecordKey,
} from '../identity/personal-settings.js';
import { getServerRecords, ServerRecordError } from '../storage/index.js';

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
  /** The stored value, or `undefined` when nothing was ever saved. */
  read: () => Promise<unknown>;
  /** Resolves once `config` is durable. */
  write: (config: AgentDefaults) => Promise<void>;
  /**
   * Write `config` only if nothing was ever saved, deciding that in the same
   * serialized step as the write, so an explicit save that lands first wins.
   * Resolves to what is stored afterwards.
   */
  initialize: (config: AgentDefaults) => Promise<unknown>;
}

function corruptDefaults(error: unknown): unknown {
  if (!(error instanceof ServerRecordError)) return error;
  return new AgentDefaultsError(
    'agent_defaults_corrupt',
    'Invalid Agent defaults file: malformed JSON',
    { cause: error },
  );
}

const recordStorage: AgentDefaultsStorage = {
  async read() {
    try {
      return (
        (await getServerRecords().get(settingsRecordKey('agent-defaults'))) ??
        undefined
      );
    } catch (error) {
      throw corruptDefaults(error);
    }
  },
  write: (config) =>
    getServerRecords().put(settingsRecordKey('agent-defaults'), config),
  async initialize(config) {
    try {
      return await getServerRecords().update(
        settingsRecordKey('agent-defaults'),
        (current) => current ?? config,
      );
    } catch (error) {
      throw corruptDefaults(error);
    }
  },
};

export class AgentDefaultsService {
  constructor(private readonly storage: AgentDefaultsStorage = recordStorage) {}

  async getAgentDefaults(): Promise<AgentDefaults> {
    return this.parseDefaults(await this.storage.read());
  }

  private parseDefaults(stored: unknown): AgentDefaults {
    if (stored === undefined)
      return {
        profileId: personalSettingsOwner() ? 'huabu' : null,
        functionalModel: '',
      };
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

  async requireDefaultAgentProfileId(): Promise<string> {
    const { profileId } = await this.getAgentDefaults();
    if (profileId === null) {
      throw new AgentDefaultsError(
        'default_profile_unconfigured',
        'Select a Utility Agent in Settings',
      );
    }
    return profileId;
  }

  async setAgentDefaults(config: AgentDefaults): Promise<AgentDefaults> {
    const parsed = agentDefaultsSchema.parse(config);
    await this.storage.write(parsed);
    return parsed;
  }

  async initializeAgentDefaults(
    profiles: readonly AgentProfileView[],
  ): Promise<AgentDefaults> {
    const stored = await this.storage.read();
    const current = this.parseDefaults(stored);
    if (stored !== undefined) return current;
    const candidates = profiles.filter(
      (profile) => profile.id !== 'huabu' && profile.visible !== false,
    );
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
    return this.parseDefaults(
      await this.storage.initialize(
        agentDefaultsSchema.parse({ ...current, profileId: candidates[0].id }),
      ),
    );
  }
}

const service = new AgentDefaultsService();
export const getAgentDefaults = (): Promise<AgentDefaults> =>
  service.getAgentDefaults();
export const requireDefaultAgentProfileId = (): Promise<string> =>
  service.requireDefaultAgentProfileId();
export const setAgentDefaults = (
  config: AgentDefaults,
): Promise<AgentDefaults> => service.setAgentDefaults(config);
export const initializeAgentDefaults = (
  profiles: readonly AgentProfileView[],
): Promise<AgentDefaults> =>
  service.initializeAgentDefaults(
    profiles.filter((profile) =>
      resolveConnectedAgentletId(profile.agentletId),
    ),
  );
