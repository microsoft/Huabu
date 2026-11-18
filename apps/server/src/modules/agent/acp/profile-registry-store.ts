// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  decodeAgentProfileRegistry,
  encodeAgentProfileRegistry,
} from '@agenetes/agent-profile';

import { getServerRecords } from '../../storage/index.js';

import type {
  AgentProfileRegistryState,
  AgentProfileRegistryStore,
} from '@agenetes/agent-profile';

/**
 * The Agent Profile registry kept as a deployment server record, in the same
 * `{ schemaVersion: 1, state }` document Agenetes' file store writes.
 *
 * @param name `user-agent-profiles` in Bubble mode, where every member's
 *   Profiles share one registry filtered by device owner, and
 *   `agent-profiles` in local mode.
 */
export function agentProfileRecordStore(
  name: 'agent-profiles' | 'user-agent-profiles',
): AgentProfileRegistryStore {
  const key = { owner: null, name } as const;
  return {
    load(): AgentProfileRegistryState | null {
      const value = getServerRecords().get(key);
      return value === null ? null : decodeAgentProfileRegistry(value);
    },
    save(state: AgentProfileRegistryState): Promise<void> {
      return getServerRecords().put(key, encodeAgentProfileRegistry(state));
    },
  };
}
