/**
 * Spawn orchestration between Sediment's profile store and the
 * embedded agentlet daemon.
 *
 * The user-facing model is a list of long-lived "agent profiles"
 * (cli + cwd + flags). The daemon-facing model is a pool of live
 * agent processes addressed by opaque `agentletAgentId`. This module
 * bridges the two:
 *
 *   `ensureAgentForProfile(profileId)`
 *     → returns `{agentletAgentId, pid}` for the agent currently
 *       hosting that profile, spawning a new one on the daemon if
 *       none is alive.
 *
 *   `getRuntime(profileId)`
 *     → quick, side-effect-free read used by the profiles route
 *       when rendering list responses (no spawn).
 *
 *   `releaseProfile(profileId)`
 *     → drop the cached mapping (caller asks the daemon to stop the
 *       agent). Used when a profile is deleted.
 *
 * Caching: the map lives in this process's memory and is keyed
 * `profileId → agentletAgentId`. A daemon disconnect invalidates the
 * entire cache because the new daemon (re-fork by the supervisor)
 * starts with an empty agent pool. We detect the swap by tracking
 * `currentDaemonId` and wiping the map whenever it changes.
 */

import { getDaemonSupervisor } from './daemon-supervisor.js';
import { getProfile } from './profile-store.js';
import { getAgentletServer } from './server-mount.js';

import type { AcpAgentProfileRuntime } from '@sediment/shared';

interface CachedAgent {
  agentletAgentId: string;
  pid: number;
  /** Which daemon instance owns this agent. */
  daemonId: string;
}

const profileToAgent = new Map<string, CachedAgent>();
/**
 * The daemonId we believe is currently connected. Set on every
 * `ensureAgentForProfile` / `getRuntime` call by `readActiveDaemon`;
 * a change drops the entire cache because the previous daemon's
 * agents are by definition dead with their parent.
 */
let activeDaemonId: string | null = null;

/**
 * Resolve the single connected daemon (we only ever run one) and
 * invalidate the per-profile cache when it has been replaced since
 * the last call. Returns `null` when no daemon is currently online.
 */
function readActiveDaemon(): {
  daemonId: string;
} | null {
  const server = getAgentletServer();
  if (!server) return null;
  // We supervise exactly one daemon — taking the first registered
  // entry is sufficient and avoids exposing a daemon-id surface to
  // the UI. If the supervisor architecture ever evolves to support
  // multiple daemons we'd need a routing decision here, but the
  // ticket-shaped API surface stays the same.
  const live = server.getDaemons();
  const daemon = live[0];
  if (!daemon) return null;
  if (activeDaemonId && activeDaemonId !== daemon.daemonId) {
    profileToAgent.clear();
  }
  activeDaemonId = daemon.daemonId;
  return { daemonId: daemon.daemonId };
}

/**
 * Return the spawn-cached runtime for a profile WITHOUT touching the
 * daemon. Used by the profiles route to enrich list responses with
 * `runtime.spawned / pid` without forcing a spawn on every poll.
 */
export function getRuntime(profileId: string): AcpAgentProfileRuntime {
  const daemon = readActiveDaemon();
  if (!daemon) return { spawned: false };
  const cached = profileToAgent.get(profileId);
  if (!cached || cached.daemonId !== daemon.daemonId) {
    return { spawned: false };
  }
  // Verify the agent is still connected — the daemon could have lost
  // it (CLI crash, autoRestart=false) without our cache noticing yet.
  const server = getAgentletServer();
  const conn = server?.getConnection(cached.agentletAgentId);
  if (!conn || conn.status !== 'connected') {
    profileToAgent.delete(profileId);
    return { spawned: false };
  }
  return {
    spawned: true,
    agentletAgentId: cached.agentletAgentId,
    pid: cached.pid,
  };
}

/**
 * Ensure a live agent process exists for `profileId`, spawning one
 * via the daemon if needed.
 *
 * Throws when:
 *   • the profile does not exist,
 *   • no daemon is currently connected (supervisor offline),
 *   • the daemon RPC for spawn fails.
 *
 * Idempotent within a single daemon's lifetime — repeat calls return
 * the same `agentletAgentId` until the agent dies or the daemon is
 * re-forked.
 */
export async function ensureAgentForProfile(
  profileId: string,
): Promise<{ agentletAgentId: string; pid: number }> {
  const profile = getProfile(profileId);
  if (!profile) {
    throw new Error(`No profile with id ${profileId}`);
  }
  const daemon = readActiveDaemon();
  if (!daemon) {
    const supervisorStatus = getDaemonSupervisor().getStatus();
    const hint = supervisorStatus.lastError
      ? ` (${supervisorStatus.lastError})`
      : '';
    throw new Error(
      `External agent worker is not ready${hint}. Try "Restart worker" in Settings → External Agents.`,
    );
  }

  const cached = profileToAgent.get(profileId);
  if (cached && cached.daemonId === daemon.daemonId) {
    const server = getAgentletServer();
    const conn = server?.getConnection(cached.agentletAgentId);
    if (conn && conn.status === 'connected') {
      return {
        agentletAgentId: cached.agentletAgentId,
        pid: cached.pid,
      };
    }
    // Stale cache — agent died since the last call. Fall through to
    // a fresh spawn.
    profileToAgent.delete(profileId);
  }

  const server = getAgentletServer();
  if (!server) {
    throw new Error('agentlet server is not mounted');
  }

  const { agentId, pid } = await server.spawnOnDaemon(daemon.daemonId, {
    command: profile.command,
    cwd: profile.cwd,
    env: profile.env,
    autoRestart: profile.autoRestart,
  });

  profileToAgent.set(profileId, {
    agentletAgentId: agentId,
    pid,
    daemonId: daemon.daemonId,
  });
  return { agentletAgentId: agentId, pid };
}

/**
 * Drop the cached mapping for `profileId` and best-effort ask the
 * daemon to stop the spawned agent. Called when a profile is deleted
 * — leaving a zombie agent process behind is acceptable (the daemon
 * will reap it on its own shutdown) but wasteful, so we make a
 * best-effort stop request and swallow any error.
 */
export async function releaseProfile(profileId: string): Promise<void> {
  const cached = profileToAgent.get(profileId);
  profileToAgent.delete(profileId);
  if (!cached) return;
  const server = getAgentletServer();
  if (!server) return;
  try {
    await server.stopOnDaemon(cached.daemonId, {
      agentId: cached.agentletAgentId,
    });
  } catch {
    // Best-effort: a dying daemon, already-stopped agent, or unknown
    // id are all acceptable here. Caller already removed the profile.
  }
}

/** Test-only: clear the cache between vitest cases. */
export function _resetSpawnOrchestratorForTests(): void {
  profileToAgent.clear();
  activeDaemonId = null;
}
