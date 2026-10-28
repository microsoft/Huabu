// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { CUSTOM_COMMAND_WRAPPER_ID } from '@agentlet/protocol';

import { formatAgentletDeviceDisplayName } from '../agentlet-device-display.js';

import type {
  AgentProfile,
  AgentProfileRegistry,
} from '@agenetes/agent-profile';
import type {
  HarnessDiscoveryParams,
  HarnessDiscoveryResult,
} from '@agentlet/protocol';
import type {
  AcpAgentletDiscoveryErrorDetails,
  AcpAgentletDiscoveryResponse,
  CustomData,
  JsonValue,
} from '@huabu/shared';
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
  getAgentlets(filter: { status: 'connected' }): Array<{
    agentletId: string;
    agentletProfile?: {
      machine?: {
        hostname?: string;
        platform?: string;
        arch?: string;
      };
    };
  }>;
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

export class HarnessProfileDiscoveryError extends Error {
  constructor(
    readonly code:
      | 'agentlet_unavailable'
      | 'harness_discovery_stale'
      | 'profile_registry_unavailable'
      | 'harness_discovery_unsupported'
      | 'harness_discovery_unavailable'
      | 'harness_reconciliation_failed',
    readonly status: 409 | 500 | 503,
    message: string,
    readonly details?: AcpAgentletDiscoveryErrorDetails,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function registerHarnessProfileDiscovery({
  gateway,
  getRegistry,
  log,
  onProfilesDiscovered,
}: DiscoveryOptions) {
  const generations = new Map<string, number>();
  const inFlight = new Map<string, Promise<AcpAgentletDiscoveryResponse>>();
  let disposed = false;

  const connectedDevice = (agentletId: string) =>
    gateway
      .getAgentlets({ status: 'connected' })
      .find((candidate) => candidate.agentletId === agentletId);

  const runDiscovery = async (
    agentletId: string,
    generation: number | undefined,
  ): Promise<AcpAgentletDiscoveryResponse> => {
    const assertCurrent = () => {
      if (disposed || generations.get(agentletId) !== generation) {
        throw new HarnessProfileDiscoveryError(
          'harness_discovery_stale',
          409,
          'The device connection changed. Detect installed Agents again.',
        );
      }
      if (!connectedDevice(agentletId)) {
        throw new HarnessProfileDiscoveryError(
          'agentlet_unavailable',
          409,
          'The selected device is not connected.',
        );
      }
    };
    assertCurrent();
    let result: HarnessDiscoveryResult;
    try {
      result = await gateway.discoverHarnesses(agentletId, {
        prepareWorkspaces: true,
      });
    } catch (error) {
      assertCurrent();
      const unsupported =
        error instanceof Error &&
        'code' in error &&
        error.code === 'harness_discovery_unsupported';
      throw new HarnessProfileDiscoveryError(
        unsupported
          ? 'harness_discovery_unsupported'
          : 'harness_discovery_unavailable',
        503,
        unsupported
          ? 'Update Agentlet on this device to detect installed Agents.'
          : 'Agentlet harness detection is unavailable. Try again.',
        undefined,
        { cause: error },
      );
    }
    assertCurrent();
    const registry = getRegistry();
    if (!registry) {
      throw new HarnessProfileDiscoveryError(
        'profile_registry_unavailable',
        503,
        'Agent Profile registry is not ready.',
      );
    }
    const response: AcpAgentletDiscoveryResponse = {
      agentletId,
      harnesses: result.harnesses
        .filter((harness) => harness.id !== CUSTOM_COMMAND_WRAPPER_ID)
        .map((harness) => ({ ...harness, profileStatus: 'skipped' })),
    };
    const createdProfileIds: string[] = [];

    try {
      for (const harness of response.harnesses) {
        for (const diagnostic of harness.diagnostics ?? []) {
          log.warn(
            { agentletId, harnessId: harness.id, ...diagnostic },
            '[acp] harness discovery diagnostic',
          );
        }
        if (harness.status !== 'ready') continue;
        if (!harness.workingDirPath) {
          log.warn(
            { agentletId, harnessId: harness.id },
            '[acp] discovered harness has no usable default workspace',
          );
          continue;
        }
        // No await between the lookup and the synchronous registry commit.
        const profiles = registry.listProfiles();
        const existing = profiles.find((profile) => {
          const source = parseSource(profile.customData?.[SOURCE_KEY]);
          return (
            profile.agentletId === agentletId &&
            source?.agentletId === agentletId &&
            source.harnessId === harness.id &&
            profile.launch.kind === 'acp-harness' &&
            profile.launch.harnessId === harness.id
          );
        });
        if (existing) {
          harness.profileStatus = 'existing';
          harness.profileId = existing.id;
          continue;
        }
        assertCurrent();
        const connection = connectedDevice(agentletId);
        const defaultAlias = `${harness.displayName} (${formatAgentletDeviceDisplayName(
          connection?.agentletProfile?.machine,
        )})`;
        const common = {
          agentletId,
          alias: profiles.some((profile) => profile.alias === defaultAlias)
            ? `${defaultAlias} [${harness.id}]`
            : defaultAlias,
          ...(harness.id === 'proxy' ? { visible: false } : {}),
          workingDirPath: harness.workingDirPath,
          metadata: { cliId: harness.id },
          customData: {
            [SOURCE_KEY]: { version: 1, agentletId, harnessId: harness.id },
          },
        };
        const profile = registry.createProfile({
          ...common,
          launchKind: 'acp-harness',
          harnessId: harness.id,
          ...(harness.capabilities.autoApprove
            ? { options: { autoApprove: true } }
            : {}),
        });
        createdProfileIds.push(profile.id);
        harness.profileStatus = 'created';
        harness.profileId = profile.id;
        log.info(
          { agentletId, harnessId: harness.id, profileId: profile.id },
          '[acp] automatically created Profile',
        );
      }
      onProfilesDiscovered?.(registry.listProfiles());
    } catch (error) {
      if (error instanceof HarnessProfileDiscoveryError) throw error;
      throw new HarnessProfileDiscoveryError(
        'harness_reconciliation_failed',
        500,
        'Could not finish creating automatic Profiles. Saved additions are retained; try again.',
        { createdProfileIds },
        { cause: error },
      );
    }
    return {
      ...response,
      harnesses: response.harnesses.filter((entry) => entry.id !== 'proxy'),
    };
  };

  const discover = (agentletId: string) => {
    const current = inFlight.get(agentletId);
    if (current) return current;
    const request = runDiscovery(agentletId, generations.get(agentletId));
    inFlight.set(agentletId, request);
    const clear = () => {
      if (inFlight.get(agentletId) === request) inFlight.delete(agentletId);
    };
    void request.then(clear, clear);
    return request;
  };

  const onChanged: Parameters<DiscoveryGateway['onAgentletsChanged']>[0] = ({
    agentletId,
    status,
  }) => {
    if (disposed) return;
    const generation = (generations.get(agentletId) ?? 0) + 1;
    generations.set(agentletId, generation);
    inFlight.delete(agentletId);
    if (status === 'connected') {
      void discover(agentletId).catch((error: unknown) => {
        if (disposed || generations.get(agentletId) !== generation) return;
        log.warn({ agentletId, err: error }, '[acp] harness discovery failed');
      });
    }
  };

  const unsubscribe = gateway.onAgentletsChanged(onChanged);
  for (const { agentletId } of gateway.getAgentlets({ status: 'connected' })) {
    onChanged({ agentletId, status: 'connected' });
  }
  const dispose = () => {
    disposed = true;
    generations.clear();
    inFlight.clear();
    unsubscribe();
  };
  return { discover, dispose };
}
