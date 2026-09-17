// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  AgentletRequestError,
  getAgentTeamRegistry,
  getAgentletGateway,
} from '@agenetes/agentlet-host';

import {
  DISCOVERED_AGENT_CUSTOM_DATA_KEY,
  discoveredAgentProfileProvenanceSchema,
} from '@huabu/shared';

import {
  KNOWN_CLIS,
  buildKnownCliCommand,
  type KnownCli,
} from './known-agents.js';

import type { AcpCommandProfile } from '@agenetes/agentlet-host';
import type {
  AcpAgentCliListResponse,
  AcpAgentMachineDiscovery,
  AcpDiscoveredAgent,
  ValidateAcpWorkingDirectoryResponse,
} from '@huabu/shared';
import type { FastifyBaseLogger } from 'fastify';

type Gateway = NonNullable<ReturnType<typeof getAgentletGateway>>;

interface CachedMachine {
  snapshot: AcpAgentMachineDiscovery;
  generation: number;
}

interface StructuredAgentletErrorData {
  code?: unknown;
}

export class AcpMachineDiscoveryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: 400 | 404 | 409 | 503 = 503,
  ) {
    super(message);
    this.name = 'AcpMachineDiscoveryError';
  }
}

function projectKnownCli(
  cli: KnownCli,
  agentletId: string,
  hostname: string,
  platform: string,
  status: AcpDiscoveredAgent['status'],
  error?: AcpDiscoveredAgent['error'],
): AcpDiscoveredAgent {
  return {
    agentletId,
    hostname,
    platform,
    harnessId: cli.id,
    displayName: cli.displayName,
    binary: cli.binary,
    acpArgs: [...cli.acpArgs],
    autoApprove: cli.autoApprove
      ? { ...cli.autoApprove, args: [...cli.autoApprove.args] }
      : null,
    installHint: cli.installHint,
    status,
    ...(error ? { error } : {}),
  };
}

function cloneCli(
  agentletId: string,
  hostname: string,
  platform: string,
  status: AcpDiscoveredAgent['status'],
  error?: AcpDiscoveredAgent['error'],
): AcpDiscoveredAgent[] {
  return KNOWN_CLIS.map((cli) =>
    projectKnownCli(cli, agentletId, hostname, platform, status, error),
  );
}

function agentletErrorCode(error: unknown): string | undefined {
  if (!(error instanceof AgentletRequestError)) return undefined;
  const data = error.data as StructuredAgentletErrorData | undefined;
  return typeof data?.code === 'string' ? data.code : undefined;
}

function machineMetadata(connection: ReturnType<Gateway['getAgentlet']>): {
  hostname: string;
  platform: string;
} {
  const machine = connection?.agentletProfile?.machine;
  return {
    hostname: machine?.hostname ?? connection?.agentletId ?? 'unknown',
    platform: machine?.platform ?? 'unknown',
  };
}

function isCommandProfile(profile: unknown): profile is AcpCommandProfile {
  return (
    typeof profile === 'object' &&
    profile !== null &&
    'launch' in profile &&
    (profile as AcpCommandProfile).launch.kind === 'acp-command'
  );
}

export class AcpMachineDiscoveryService {
  private readonly machines = new Map<string, CachedMachine>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly getGateway: () => Gateway | null = getAgentletGateway,
    private readonly logger?: Pick<FastifyBaseLogger, 'warn'>,
  ) {}

  attach(gateway: Gateway): () => void {
    this.unsubscribe?.();
    this.synchronizeMachines(gateway);
    const refreshAfterMachineChange = () => {
      this.synchronizeMachines(gateway);
      for (const connection of gateway.getAgentlets({ status: 'connected' })) {
        void this.refreshOne(connection.agentletId, true).catch((error) => {
          this.logger?.warn(
            { error, agentletId: connection.agentletId },
            '[acp/discovery] connection refresh failed',
          );
        });
      }
    };
    this.unsubscribe = gateway.onAgentTeamMachinesChanged(
      refreshAfterMachineChange,
    );
    refreshAfterMachineChange();
    return () => {
      this.unsubscribe?.();
      this.unsubscribe = null;
    };
  }

  list(): AcpAgentCliListResponse {
    const gateway = this.getGateway();
    if (gateway) this.synchronizeMachines(gateway);
    return {
      machines: [...this.machines.values()]
        .map(({ snapshot }) => structuredClone(snapshot))
        .sort((a, b) => a.agentletId.localeCompare(b.agentletId)),
    };
  }

  async refresh(agentletId?: string): Promise<AcpAgentCliListResponse> {
    const gateway = this.requireGateway();
    this.synchronizeMachines(gateway);
    const ids = agentletId
      ? [agentletId]
      : gateway
          .getAgentlets({ status: 'connected' })
          .map((connection) => connection.agentletId);
    if (agentletId && !gateway.getAgentlet(agentletId)) {
      throw new AcpMachineDiscoveryError(
        'agentlet_not_found',
        `No execution machine with id ${agentletId}`,
        404,
      );
    }
    await Promise.all(ids.map((id) => this.refreshOne(id, false)));
    return this.list();
  }

  async validateWorkingDirectory(
    agentletId: string,
    workingDirPath?: string,
  ): Promise<ValidateAcpWorkingDirectoryResponse> {
    const gateway = this.requireConnectedGateway(agentletId);
    try {
      const result = await gateway.validateNativePath(agentletId, {
        ...(workingDirPath === undefined ? {} : { cwd: workingDirPath }),
      });
      return {
        agentletId,
        workingDirPath: result.cwd,
        source: result.source === 'default' ? 'machine_default' : 'explicit',
        valid: true,
      };
    } catch (error) {
      const code = agentletErrorCode(error);
      if (
        code === 'default_cwd_unavailable' ||
        code === 'path_not_absolute' ||
        code === 'path_not_found' ||
        code === 'path_not_directory'
      ) {
        throw new AcpMachineDiscoveryError(
          code,
          error instanceof Error ? error.message : String(error),
          400,
        );
      }
      if (code === 'unsupported_capability') {
        throw new AcpMachineDiscoveryError(
          code,
          'The execution machine does not support native path validation',
          503,
        );
      }
      throw new AcpMachineDiscoveryError(
        'path_validation_failed',
        error instanceof Error ? error.message : String(error),
        503,
      );
    }
  }

  async materialize(
    agentletId: string,
    harnessId: string,
    workingDirPath?: string,
  ): Promise<AcpCommandProfile> {
    const machine = this.machines.get(agentletId)?.snapshot;
    const connection =
      this.requireConnectedGateway(agentletId).getAgentlet(agentletId);
    if (!machine || !connection || !machine.connected) {
      throw new AcpMachineDiscoveryError(
        'agentlet_offline',
        `Execution machine ${agentletId} is offline`,
        409,
      );
    }
    const observation = machine.agents.find(
      (agent) => agent.harnessId === harnessId,
    );
    if (!observation) {
      throw new AcpMachineDiscoveryError(
        'harness_not_found',
        `Unknown Agent harness ${harnessId}`,
        404,
      );
    }
    if (machine.discovery !== 'ready' || observation.status !== 'installed') {
      throw new AcpMachineDiscoveryError(
        'harness_not_installed',
        `Agent harness ${harnessId} is not currently installed on ${agentletId}`,
        409,
      );
    }
    const validated = await this.validateWorkingDirectory(
      agentletId,
      workingDirPath,
    );
    const registry = getAgentTeamRegistry();
    if (!registry) {
      throw new AcpMachineDiscoveryError(
        'profile_registry_unavailable',
        'Agent Profile registry is not ready',
      );
    }
    const existing = registry.listProfiles().find((profile) => {
      if (!isCommandProfile(profile)) return false;
      const provenance = discoveredAgentProfileProvenanceSchema.safeParse(
        profile.customData?.[DISCOVERED_AGENT_CUSTOM_DATA_KEY],
      );
      return (
        provenance.success &&
        provenance.data.agentletId === agentletId &&
        provenance.data.harnessId === harnessId &&
        profile.agentletId === agentletId &&
        profile.workingDirPath === validated.workingDirPath &&
        profile.metadata?.cliId === harnessId
      );
    });
    if (existing && isCommandProfile(existing)) return existing;

    const cli = KNOWN_CLIS.find((candidate) => candidate.id === harnessId);
    if (!cli) {
      throw new AcpMachineDiscoveryError(
        'harness_not_found',
        `Unknown Agent harness ${harnessId}`,
        404,
      );
    }
    const created = registry.createProfile({
      launchKind: 'acp-command',
      alias: cli.displayName,
      agentletId,
      command: buildKnownCliCommand(cli),
      workingDirPath: validated.workingDirPath,
      metadata: { cliId: cli.id },
      customData: {
        [DISCOVERED_AGENT_CUSTOM_DATA_KEY]: {
          version: 1,
          agentletId,
          harnessId,
        },
      },
    });
    if (!isCommandProfile(created)) {
      throw new Error('Agent Profile registry returned an invalid kind');
    }
    return created;
  }

  private requireGateway(): Gateway {
    const gateway = this.getGateway();
    if (!gateway) {
      throw new AcpMachineDiscoveryError(
        'agentlet_gateway_unavailable',
        'Execution-machine Gateway is not ready',
      );
    }
    return gateway;
  }

  private requireConnectedGateway(agentletId: string): Gateway {
    const gateway = this.requireGateway();
    const connection = gateway.getAgentlet(agentletId);
    if (!connection) {
      throw new AcpMachineDiscoveryError(
        'agentlet_not_found',
        `No execution machine with id ${agentletId}`,
        404,
      );
    }
    if (connection.status !== 'connected') {
      throw new AcpMachineDiscoveryError(
        'agentlet_offline',
        `Execution machine ${agentletId} is offline`,
        409,
      );
    }
    return gateway;
  }

  private synchronizeMachines(gateway: Gateway): void {
    for (const connection of gateway.getAgentlets()) {
      const current = this.machines.get(connection.agentletId);
      const metadata = machineMetadata(connection);
      const connected = connection.status === 'connected';
      const snapshot: AcpAgentMachineDiscovery = current
        ? {
            ...current.snapshot,
            ...metadata,
            connected,
            ...(connected
              ? { connectedAt: connection.connectedAt.toISOString() }
              : { connectedAt: undefined }),
          }
        : {
            agentletId: connection.agentletId,
            ...metadata,
            connected,
            ...(connected
              ? { connectedAt: connection.connectedAt.toISOString() }
              : {}),
            discovery: 'refreshing',
            agents: cloneCli(
              connection.agentletId,
              metadata.hostname,
              metadata.platform,
              'error',
              {
                code: 'not_refreshed',
                message: 'Agent discovery has not completed yet',
              },
            ),
          };
      snapshot.agents = snapshot.agents.map((agent) => ({
        ...agent,
        hostname: metadata.hostname,
        platform: metadata.platform,
      }));
      this.machines.set(connection.agentletId, {
        snapshot,
        generation: current?.generation ?? 0,
      });
    }
  }

  private refreshOne(agentletId: string, supersede: boolean): Promise<void> {
    const existing = this.inFlight.get(agentletId);
    if (existing && !supersede) return existing;
    const gateway = this.requireConnectedGateway(agentletId);
    const connection = gateway.getAgentlet(agentletId);
    if (!connection) return Promise.resolve();
    const metadata = machineMetadata(connection);
    const cached = this.machines.get(agentletId);
    const generation = (cached?.generation ?? 0) + 1;
    this.machines.set(agentletId, {
      generation,
      snapshot: {
        ...(cached?.snapshot ?? {
          agentletId,
          ...metadata,
          connected: true,
          agents: [],
        }),
        ...metadata,
        connected: true,
        connectedAt: connection.connectedAt.toISOString(),
        discovery: 'refreshing',
        error: undefined,
      },
    });

    const pending = this.runRefresh(gateway, agentletId, metadata, generation);
    this.inFlight.set(agentletId, pending);
    void pending.finally(() => {
      if (this.inFlight.get(agentletId) === pending) {
        this.inFlight.delete(agentletId);
      }
    });
    return pending;
  }

  private async runRefresh(
    gateway: Gateway,
    agentletId: string,
    metadata: { hostname: string; platform: string },
    generation: number,
  ): Promise<void> {
    const connection = gateway.getAgentlet(agentletId);
    const control = connection?.agentletProfile?.capabilities.control;
    if (control?.version !== 1 || !control.harnessDiscovery) {
      this.commitRefresh(agentletId, generation, {
        discovery: 'unsupported',
        defaultWorkingDirPath: undefined,
        agents: cloneCli(
          agentletId,
          metadata.hostname,
          metadata.platform,
          'error',
          {
            code: 'unsupported_capability',
            message: 'The execution machine does not support Agent discovery',
          },
        ),
        error: {
          code: 'unsupported_capability',
          message: 'The execution machine does not support Agent discovery',
        },
      });
      return;
    }

    try {
      const discovery = await gateway.discoverHarnesses(agentletId, {
        harnesses: KNOWN_CLIS.map((cli) => ({
          harnessId: cli.id,
          executable: cli.binary,
          ...(cli.skipVersionProbe
            ? {}
            : { versionProbe: { args: ['--version'] } }),
        })),
      });
      let defaultPath: Awaited<
        ReturnType<Gateway['validateNativePath']>
      > | null = null;
      if (control.nativePathValidation) {
        try {
          defaultPath = await gateway.validateNativePath(agentletId);
        } catch (error) {
          this.logger?.warn(
            { error, agentletId },
            '[acp/discovery] target default working directory is unavailable',
          );
        }
      }
      const observations = new Map(
        discovery.harnesses.map((observation) => [
          observation.harnessId,
          observation,
        ]),
      );
      const agents = KNOWN_CLIS.map((cli): AcpDiscoveredAgent => {
        const observation = observations.get(cli.id);
        const base = projectKnownCli(
          cli,
          agentletId,
          metadata.hostname,
          metadata.platform,
          observation?.status === 'installed'
            ? 'installed'
            : observation?.status === 'missing'
              ? 'missing'
              : 'error',
        );
        if (observation?.status === 'installed') {
          return {
            ...base,
            ...(observation.version ? { version: observation.version } : {}),
          };
        }
        if (observation?.status === 'probe_failed') {
          return {
            ...base,
            error: { code: 'probe_failed', message: observation.error },
          };
        }
        if (!observation) {
          return {
            ...base,
            error: {
              code: 'observation_missing',
              message: 'The execution machine omitted this harness result',
            },
          };
        }
        return base;
      });
      this.commitRefresh(agentletId, generation, {
        discovery: 'ready',
        agents,
        defaultWorkingDirPath: defaultPath?.cwd,
        refreshedAt: Date.now(),
        error: undefined,
      });
    } catch (error) {
      const code = agentletErrorCode(error);
      const unsupported = code === 'unsupported_capability';
      const message = error instanceof Error ? error.message : String(error);
      this.commitRefresh(agentletId, generation, {
        discovery: unsupported ? 'unsupported' : 'error',
        defaultWorkingDirPath: undefined,
        agents: cloneCli(
          agentletId,
          metadata.hostname,
          metadata.platform,
          'error',
          { code: code ?? 'discovery_failed', message },
        ),
        error: { code: code ?? 'discovery_failed', message },
      });
    }
  }

  private commitRefresh(
    agentletId: string,
    generation: number,
    patch: Partial<AcpAgentMachineDiscovery>,
  ): void {
    const current = this.machines.get(agentletId);
    if (!current || current.generation !== generation) return;
    const connection = this.getGateway()?.getAgentlet(agentletId);
    this.machines.set(agentletId, {
      generation,
      snapshot: {
        ...current.snapshot,
        ...patch,
        connected: connection?.status === 'connected',
        ...(connection?.status === 'connected'
          ? { connectedAt: connection.connectedAt.toISOString() }
          : { connectedAt: undefined }),
      },
    });
  }
}

export const acpMachineDiscovery = new AcpMachineDiscoveryService();
