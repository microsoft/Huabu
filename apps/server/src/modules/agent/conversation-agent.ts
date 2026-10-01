// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getAgentProfileRegistry } from '@agenetes/agentlet-host';

import { conversationAgentPreferenceSchema } from '@huabu/shared';

import { getDataDir } from '../../data-dir.js';
import { atomicWriteJson } from '../../utils/fs.js';

import type { ConversationAgentPreference } from '@huabu/shared';

interface ConversationAgentStorage {
  read: () => unknown;
  write: (preference: ConversationAgentPreference) => void;
}

function configPath(): string {
  return join(getDataDir(), 'conversation-agent.json');
}

const diskStorage: ConversationAgentStorage = {
  read() {
    let text: string;
    try {
      text = readFileSync(configPath(), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    return JSON.parse(text) as unknown;
  },
  write: (preference) => atomicWriteJson(configPath(), preference),
};

export class ConversationAgentService {
  constructor(
    private readonly storage: ConversationAgentStorage = diskStorage,
    private readonly listSelectableProfileIds: () => string[] = () =>
      getAgentProfileRegistry()?.listSelectableProfileIds() ?? [],
  ) {}

  getPreference(): ConversationAgentPreference {
    const stored = this.storage.read();
    if (stored === undefined) return { profileId: null };
    return conversationAgentPreferenceSchema.parse(stored);
  }

  setPreference(
    preference: ConversationAgentPreference,
  ): ConversationAgentPreference {
    const parsed = conversationAgentPreferenceSchema.parse(preference);
    this.storage.write(parsed);
    return parsed;
  }

  effectiveProfileId(): string | null {
    const { profileId } = this.getPreference();
    if (profileId) return profileId;
    return this.listSelectableProfileIds()[0] ?? null;
  }
}

const service = new ConversationAgentService();

export const getConversationAgentPreference = () => service.getPreference();
export const setConversationAgentPreference = (
  preference: ConversationAgentPreference,
) => service.setPreference(preference);
export const getEffectiveConversationAgentProfileId = () =>
  service.effectiveProfileId();
export const rememberConversationAgentProfileId = (profileId: string) =>
  service.setPreference({ profileId });
