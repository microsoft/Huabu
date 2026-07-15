import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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

/** Resolve the checked-in collection in source and bundled Server layouts. */
export function resolveBundledAgentTeamsPath(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.HUABU_BUNDLED_AGENT_TEAMS_PATH,
    // tsup and Electron: agent-teams is copied next to server.js.
    join(here, 'agent-teams'),
    // tsx development: this module lives under apps/server/src/modules/.
    resolve(here, '../../../../../agent-teams'),
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
