import {
  ACP_CAPABILITIES,
  acpDriverFactory,
  type AcpCreateSpec,
  type AcpTurnCtx,
} from '@agenetes/acp-driver';
import {
  FileEventLogStore,
  FileThreadStore,
  FileTurnStore,
  mountAgenetes,
} from '@agenetes/agenetes';
import { getAgentTeamRegistry } from '@agenetes/agentlet-host';
import { piDriverFactory, type PiTurnCtx } from '@agenetes/pi-driver';

import { type AgentHandle } from './handle.js';
import { HISTORY_REPLAY_BUDGET } from './history-replay.js';
import { huabuPiDriverPorts } from './pi-driver.js';
import { getExternalAgentRuntimeConfig } from '../acp/runtime-config.js';

import type { AcpSpec } from '@agenetes/acp-driver';
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

const externalDriver = acpDriverFactory({
  getIdleTimeoutSecs: () => getExternalAgentRuntimeConfig().idleTimeoutSecs,
  resolveRuntimeEnvironment: async (spec: AcpSpec) => {
    const agentTeam = spec.recipe?.agentTeam;
    if (!agentTeam || !('workingDirPath' in agentTeam)) return undefined;
    const registry = getAgentTeamRegistry();
    if (!registry) throw new Error('Agent Profile registry is not mounted');
    const runtime = await registry.resolveManifestRuntime({
      profileId: spec.binding.profileId,
      agentletId: spec.agentletId ?? '',
      workingDirPath: agentTeam.workingDirPath,
      launch: {
        kind: 'agent-team-manifest',
        manifestPath: agentTeam.manifestPath,
        harness: agentTeam.harness,
      },
    });
    return runtime.environment;
  },
});

export const agenetes: Agenetes = mountAgenetes({
  drivers: {
    [INTERNAL_DRIVER_KIND]: piDriverFactory({ ports: huabuPiDriverPorts }),
    [EXTERNAL_DRIVER_KIND]: externalDriver,
  },
  threadStore: new FileThreadStore(),
  eventLogStore: new FileEventLogStore(),
  turnStore: new FileTurnStore(),
  // Last-resort guard only: the built-in driver already fits its replay to
  // HISTORY_REPLAY_BUDGET, so this bounds the ACP text projection, which has
  // no host materializer of its own.
  autoRecoverPolicy: {
    enabled: true,
    safeHistoryLoadLimit: HISTORY_REPLAY_BUDGET,
    onThresholdExceeded: 'deny',
  },
});

export { ACP_CAPABILITIES };
