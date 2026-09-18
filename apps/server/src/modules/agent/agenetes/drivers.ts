// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  ACP_CAPABILITIES,
  acpDriverFactory,
  type AcpCreateSpec,
  type AcpTurnCtx,
} from '@agenetes/acp-driver';
import { mountAgenetes } from '@agenetes/agenetes';
import { piDriverFactory, type PiTurnCtx } from '@agenetes/pi-driver';

import {
  conversationEventLogStore,
  conversationThreadStore,
  conversationTurnStore,
} from './conversation-stores.js';
import { type AgentHandle } from './handle.js';
import { HISTORY_LOAD_SANITY_LIMIT } from './history-replay.js';
import { huabuPiDriverPorts } from './pi-driver.js';
import { getExternalAgentRuntimeConfig } from '../acp/runtime-config.js';

import type { AcpRuntimePolicy } from '@agenetes/acp-driver';
import type { Agenetes } from '@agenetes/agenetes';
import type { PiWorkloadSpec } from '@agenetes/pi-driver';
import type { AgentHandle as RuntimeAgentHandle } from '@agenetes/runtime';
import type { Message } from '@earendil-works/pi-ai';

export const INTERNAL_DRIVER_KIND = 'internal';
export const EXTERNAL_DRIVER_KIND = 'external';

export type AcpWorkloadSpec = AcpCreateSpec;
export type BuiltinWorkloadSpec = PiWorkloadSpec;
export type AcpHandle = AgentHandle<void, AcpTurnCtx>;
export type BuiltinHandle = AgentHandle<Message[], PiTurnCtx>;
export type AgenetesHandle = RuntimeAgentHandle;

export const acpRuntimePolicy: AcpRuntimePolicy = {
  getIdleTimeoutSecs: () => getExternalAgentRuntimeConfig().idleTimeoutSecs,
};

const externalDriver = acpDriverFactory(acpRuntimePolicy);

export const agenetes: Agenetes = mountAgenetes({
  drivers: {
    [INTERNAL_DRIVER_KIND]: piDriverFactory({ ports: huabuPiDriverPorts }),
    [EXTERNAL_DRIVER_KIND]: externalDriver,
  },
  // Dispatchers, not one backing: which store owns a conversation depends on
  // where its Space lives, and that is a runtime fact (`conversation-stores`).
  threadStore: conversationThreadStore,
  eventLogStore: conversationEventLogStore,
  turnStore: conversationTurnStore,
  // Corruption guard, not a context budget: replay restores whatever the
  // live handle would still be holding, and trimming that is the
  // conversation's problem, not recovery's.
  autoRecoverPolicy: {
    enabled: true,
    safeHistoryLoadLimit: HISTORY_LOAD_SANITY_LIMIT,
    onThresholdExceeded: 'deny',
  },
});

export { ACP_CAPABILITIES };
