// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { CUSTOM_COMMAND_WRAPPER_ID } from '@agentlet/protocol';

import type {
  AgentProfile,
  AgentProfileRegistry,
} from '@agenetes/agent-profile';
import type {
  HarnessDiscoveryParams,
  HarnessDiscoveryResult,
} from '@agentlet/protocol';
import type { CustomData, JsonValue } from '@huabu/shared';
import type { FastifyBaseLogger } from 'fastify';

const SOURCE_KEY = 'discoveredAgent';

interface DiscoverySource {
  version: 1;
  agentletId: string;
  harnessId: string;
}

function parseSource(
  value: JsonValue | undefined,
): DiscoverySource | undefined {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.version !== 1 ||
    typeof value.agentletId !== 'string' ||
    !value.agentletId ||
    typeof value.harnessId !== 'string' ||
    !value.harnessId ||
    Object.keys(value).length !== 3
  ) {
    throw new Error('Invalid automatic Profile source');
  }
  return {
    version: 1,
    agentletId: value.agentletId,
    harnessId: value.harnessId,
  };
}

export function hasDiscoverySource(
  customData: CustomData | undefined,
): boolean {
  return (
    customData !== undefined &&
    Object.prototype.hasOwnProperty.call(customData, SOURCE_KEY)
  );
}

/** Preserve the host-owned source even when the caller replaces the opaque bag. */
export function mergeProfileCustomData(
  profile: AgentProfile,
  customData: CustomData | null,
): CustomData | null {
  const source = parseSource(profile.customData?.[SOURCE_KEY]);
  if (customData && hasDiscoverySource(customData)) {
    const supplied = parseSource(customData[SOURCE_KEY]);
    if (
      !source ||
      !supplied ||
      supplied.agentletId !== source.agentletId ||
      supplied.harnessId !== source.harnessId
    ) {
      throw new Error('Automatic Profile source cannot be changed');
    }
  }
  return source ? { ...customData, [SOURCE_KEY]: { ...source } } : customData;
}

interface DiscoveryGateway {
  getAgentlets(filter: { status: 'connected' }): Array<{ agentletId: string }>;
  onAgentletsChanged(
    handler: (event: {
      agentletId: string;
      status: 'connected' | 'disconnected';
    }) => void,
  ): () => void;
  discoverHarnesses(
    agentletId: string,
    params: HarnessDiscoveryParams,
  ): Promise<HarnessDiscoveryResult>;
}

type ProfileRegistry = Pick<
  AgentProfileRegistry,
  'listProfiles' | 'createProfile'
>;

interface DiscoveryOptions {
  gateway: DiscoveryGateway;
  getRegistry: () => ProfileRegistry | null;
  log: Pick<FastifyBaseLogger, 'info' | 'warn'>;
  onProfilesDiscovered?: (profiles: AgentProfile[]) => void;
}

export function registerHarnessProfileDiscovery({
  gateway,
  getRegistry,
  log,
  onProfilesDiscovered,
}: DiscoveryOptions): () => void {
  const generations = new Map<string, number>();
  let disposed = false;

  const discover = async (agentletId: string, generation: number) => {
    const result = await gateway.discoverHarnesses(agentletId, {
      prepareWorkspaces: true,
    });
    if (disposed || generations.get(agentletId) !== generation) return;
    const registry = getRegistry();
    if (!registry) throw new Error('Agent Profile registry is not ready');

    for (const harness of result.harnesses) {
      if (harness.id === CUSTOM_COMMAND_WRAPPER_ID) continue;
      for (const diagnostic of harness.diagnostics ?? []) {
        log.warn(
          { agentletId, harnessId: harness.id, ...diagnostic },
          '[acp] harness discovery diagnostic',
        );
      }
      if (!harness.installed) continue;
      if (!harness.workingDirPath) {
        log.warn(
          { agentletId, harnessId: harness.id },
          '[acp] discovered harness has no usable default workspace',
        );
        continue;
      }
      // No await between the lookup and the synchronous registry commit.
      const existing = registry.listProfiles().find((profile) => {
        const source = parseSource(profile.customData?.[SOURCE_KEY]);
        return (
          profile.agentletId === agentletId &&
          source?.agentletId === agentletId &&
          source.harnessId === harness.id
        );
      });
      if (existing) continue;
      const common = {
        agentletId,
        alias: `${harness.displayName} (${agentletId})`,
        workingDirPath: harness.workingDirPath,
        metadata: { cliId: harness.id },
        customData: {
          [SOURCE_KEY]: { version: 1, agentletId, harnessId: harness.id },
        },
      };
      const profile = registry.createProfile(
        harness.launchVersion === 1
          ? {
              ...common,
              launchKind: 'acp-harness',
              harnessId: harness.id,
              ...(harness.capabilities?.autoApprove === 'supported'
                ? { options: { autoApprove: true } }
                : {}),
            }
          : {
              ...common,
              launchKind: 'acp-command',
              command: [harness.binary, ...harness.acpArgs].join(' '),
            },
      );
      log.info(
        { agentletId, harnessId: harness.id, profileId: profile.id },
        '[acp] automatically created Profile',
      );
    }
    onProfilesDiscovered?.(registry.listProfiles());
  };

  const onChanged: Parameters<DiscoveryGateway['onAgentletsChanged']>[0] = ({
    agentletId,
    status,
  }) => {
    if (disposed) return;
    const generation = (generations.get(agentletId) ?? 0) + 1;
    generations.set(agentletId, generation);
    if (status === 'connected') {
      void discover(agentletId, generation).catch((error: unknown) => {
        if (disposed || generations.get(agentletId) !== generation) return;
        log.warn({ agentletId, err: error }, '[acp] harness discovery failed');
      });
    }
  };

  const unsubscribe = gateway.onAgentletsChanged(onChanged);
  for (const { agentletId } of gateway.getAgentlets({ status: 'connected' })) {
    onChanged({ agentletId, status: 'connected' });
  }
  return () => {
    disposed = true;
    generations.clear();
    unsubscribe();
  };
}
