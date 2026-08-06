// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AgentTeamRegistry } from '@agenetes/agentlet-host';
import type { FastifyBaseLogger } from 'fastify';

interface AgentTeamMachineSource {
  listAgentTeamMachines(): Array<{ machine: string }>;
  onAgentTeamMachinesChanged(handler: () => void): () => void;
}

interface RegisterBundledAgentTeamsOptions {
  bundledRootPath: string;
  localMachine: string;
  machineSource: AgentTeamMachineSource;
  getRegistry: () => Pick<
    AgentTeamRegistry,
    'addRoot' | 'listRoots' | 'removeRoot'
  > | null;
  log: Pick<FastifyBaseLogger, 'info' | 'warn'>;
}

/**
 * Walk up from `start` looking for a sibling `agent-teams` directory. Used
 * as the `tsx` development fallback so the lookup survives source-tree moves
 * (it no longer hard-codes this module's exact depth under `apps/server`).
 */
function findAgentTeamsUpwards(start: string): string | null {
  let dir = start;
  for (;;) {
    const candidate = join(dir, 'agent-teams');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Resolve the checked-in collection in source and bundled Server layouts. */
export function resolveBundledAgentTeamsPath(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.HUABU_BUNDLED_AGENT_TEAMS_PATH,
    // tsup and Electron: agent-teams is copied next to server.js.
    join(here, 'agent-teams'),
    // tsx development: search upwards for the workspace-root `agent-teams`.
    findAgentTeamsUpwards(here),
  ];
  return candidates.find((path) => path && existsSync(path)) ?? null;
}

/** Register and scan the fixed bundled collection once the local daemon exists. */
export function registerBundledAgentTeams({
  bundledRootPath,
  localMachine,
  machineSource,
  getRegistry,
  log,
}: RegisterBundledAgentTeamsOptions): () => void {
  let registered = false;
  let inFlight: Promise<void> | null = null;

  const reconcile = () => {
    if (registered || inFlight) return;
    if (
      !machineSource
        .listAgentTeamMachines()
        .some((machine) => machine.machine === localMachine)
    ) {
      return;
    }
    const registry = getRegistry();
    if (!registry) return;

    // The bundled collection is the only supported root now that Settings no
    // longer exposes root management. Drop every other root so any custom
    // root registered by an older build is cleaned up and the bundled path
    // is the single source of members.
    for (const root of registry.listRoots()) {
      if (root.machine !== localMachine || root.path !== bundledRootPath) {
        registry.removeRoot(root);
      }
    }

    inFlight = registry
      .addRoot({ machine: localMachine, path: bundledRootPath })
      .then((result) => {
        registered = result.ok;
        if (result.ok) {
          log.info(
            { bundledRootPath },
            '[agent-team] bundled collection registered',
          );
        } else {
          log.warn(
            { bundledRootPath, error: result.error },
            '[agent-team] bundled collection scan failed',
          );
        }
      })
      .catch((error: unknown) => {
        log.warn(
          { bundledRootPath, error },
          '[agent-team] bundled collection registration failed',
        );
      })
      .finally(() => {
        inFlight = null;
      });
  };

  const unsubscribe = machineSource.onAgentTeamMachinesChanged(reconcile);
  reconcile();
  return unsubscribe;
}
