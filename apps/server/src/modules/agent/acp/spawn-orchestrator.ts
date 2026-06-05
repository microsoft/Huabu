/**
 * Spawn orchestration between Sediment's per-thread binding recipes
 * and the embedded agentlet daemon.
 *
 * The user-facing model is a list of long-lived "agent profiles"
 * (cli + cwd + flags) which the UI uses as templates when creating
 * new threads. Once a thread is opened, it carries its OWN snapshot
 * of the recipe (see `AcpBindingRecipe` in `session-store.ts`) and
 * is fully decoupled from the originating profile.
 *
 * The daemon-facing model is a pool of live agent processes addressed
 * by opaque `agentletAgentId`. This module bridges the two:
 *
 *   `ensureAgentForThread(threadKey, recipe)`
 *     → returns `{agentletAgentId, pid}` for the agent currently
 *       hosting that thread, spawning a new one on the daemon if
 *       none is alive. Each thread gets its OWN CLI process; we do
 *       not share processes across threads.
 *
 *   `releaseThread(threadKey)`
 *     → drop the cached mapping and best-effort ask the daemon to
 *       stop the spawned agent. Used when a thread is deleted.
 *
 * Caching: the map lives in this process's memory and is keyed
 * `threadKey → agentletAgentId` where `threadKey = canvasId + ':' + threadId`.
 * A daemon disconnect invalidates the entire cache because the new
 * daemon (re-fork by the supervisor) starts with an empty agent pool.
 * We detect the swap by tracking `activeDaemonId` and wiping the map
 * whenever it changes.
 */

import { getDaemonSupervisor } from './daemon-supervisor.js';
import { getAgentletServer } from './server-mount.js';

import type { AcpBindingRecipe } from './session-store.js';

/**
 * Cold-start grace window for the embedded agentlet daemon's WS
 * handshake. Generous on purpose: in packaged Electron builds the
 * very first launch has to pay for ASAR unpack, on-access AV scans
 * of the freshly-extracted Node child binary, and the fork itself —
 * all of which can blow well past a few hundred ms on Windows /
 * macOS Gatekeeper systems. Subsequent launches are usually subsecond
 * because the OS has the files cached.
 *
 * We still short-circuit the wait as soon as the supervisor reports
 * `hasGivenUp()` (daemon entry missing, repeated crashes, …) so a
 * truly broken install does not make every UI affordance hang for
 * the full window.
 */
const DAEMON_READY_TIMEOUT_MS = 20_000;

interface CachedAgent {
  agentletAgentId: string;
  pid: number;
  /** Which daemon instance owns this agent. */
  daemonId: string;
}

const threadToAgent = new Map<string, CachedAgent>();
/**
 * The daemonId we believe is currently connected. Set on every
 * `ensureAgentForThread` call by `readActiveDaemon`; a change drops
 * the entire cache because the previous daemon's agents are by
 * definition dead with their parent.
 */
let activeDaemonId: string | null = null;

/** Compose the cache key for a thread on a canvas. */
export function threadKey(canvasId: string, threadId: string): string {
  return `${canvasId}:${threadId}`;
}

/**
 * Resolve the single connected daemon (we only ever run one) and
 * invalidate the per-thread cache when it has been replaced since
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
    threadToAgent.clear();
  }
  activeDaemonId = daemon.daemonId;
  return { daemonId: daemon.daemonId };
}

/**
 * Poll {@link readActiveDaemon} until a daemon is online or `timeoutMs`
 * elapses. Returns the resolved daemon descriptor or `null` on timeout
 * (or as soon as the supervisor has stopped trying — see below).
 *
 * Rationale: at server cold-start the embedded agentlet daemon is
 * forked by the supervisor and only registers itself once its WS
 * handshake completes. In dev that takes tens to a few hundred ms; in
 * packaged Electron builds the first launch can be much slower (ASAR
 * unpack, AV scanning of the just-extracted Node child binary, etc.).
 * The ChatPanel's `useAcpSessionMeta` / `useAcpSlashCommands` effects
 * fire `POST /threads/:id/session` on first mount, which previously
 * raced the handshake and got an immediate "External agent worker is
 * not ready" 503 even though the daemon came online moments later.
 * This wait closes the race so the badge never falsely shows "Failed"
 * just because the user opened the page faster than the daemon could
 * boot.
 *
 * 100 ms poll interval is well below human-perceptible latency. We
 * also bail out early when `DaemonSupervisor.hasGivenUp()` flips true
 * — that means the daemon entry is missing or the failure budget is
 * spent and no retry is scheduled, so further waiting would only
 * delay the user-facing error.
 */
async function waitForActiveDaemon(
  timeoutMs: number,
): Promise<{ daemonId: string } | null> {
  const deadline = Date.now() + timeoutMs;
  const supervisor = getDaemonSupervisor();
  let daemon = readActiveDaemon();
  while (!daemon && Date.now() < deadline) {
    if (supervisor.hasGivenUp()) return null;
    await new Promise((r) => setTimeout(r, 100));
    daemon = readActiveDaemon();
  }
  return daemon;
}

/**
 * Wait for `agentletAgentId` to report `connected` on the server's
 * connection registry, or return null on timeout. Mirrors
 * {@link waitForActiveDaemon}'s rationale at the next layer down: a
 * freshly-spawned agent goes through its own WS handshake with the
 * daemon before becoming usable, and reading its connection right
 * after `spawnOnDaemon` returns can momentarily observe `connecting`.
 */
async function waitForAgentConnection(
  agentletAgentId: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const server = getAgentletServer();
    const conn = server?.getConnection(agentletAgentId);
    if (conn?.status === 'connected') return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * Ensure a live agent process exists for `threadKey`, spawning one
 * via the daemon if needed.
 *
 * Each thread gets its OWN process — we never share an agentlet
 * connection across threads, even when the recipes are identical,
 * because the upstream CLI's state (session pool, current model,
 * mode) is per-process and would bleed across threads otherwise.
 *
 * Cold-start tolerance: we wait up to {@link DAEMON_READY_TIMEOUT_MS}
 * for the daemon to come online and up to 3 s for the freshly-spawned
 * agent to finish its handshake — see {@link waitForActiveDaemon} /
 * {@link waitForAgentConnection} for rationale. Only after both windows
 * expire (or the supervisor reports it has given up) do we surface a
 * user-facing error.
 *
 * Throws when:
 *   • the supervisor never brings the daemon online (truly offline),
 *   • the daemon RPC for spawn fails.
 *
 * Idempotent within a single daemon's lifetime — repeat calls for
 * the same `threadKey` return the same `agentletAgentId` until the
 * agent dies or the daemon is re-forked.
 */
export async function ensureAgentForThread(
  threadKey: string,
  recipe: AcpBindingRecipe,
): Promise<{ agentletAgentId: string; pid: number }> {
  const daemon = await waitForActiveDaemon(DAEMON_READY_TIMEOUT_MS);
  if (!daemon) {
    const supervisorStatus = getDaemonSupervisor().getStatus();
    const hint = supervisorStatus.lastError
      ? ` (${supervisorStatus.lastError})`
      : '';
    throw new Error(
      `External agent worker is not ready${hint}. Try "Restart worker" in Settings → External Agents.`,
    );
  }

  // Cache lookup is gated on `daemonId` match: only one daemon is alive at
  // a time, but the supervisor mints a fresh `daemonId` on every re-fork
  // (crash, OOM, user-triggered restart), so a mismatch here means the
  // cached agent belongs to a previous daemon generation and its child
  // process is by definition dead. We fall through to a fresh spawn and
  // let the `set()` at the bottom overwrite the stale entry — no explicit
  // cleanup needed.
  const cached = threadToAgent.get(threadKey);
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
    threadToAgent.delete(threadKey);
  }

  const server = getAgentletServer();
  if (!server) {
    throw new Error('agentlet server is not mounted');
  }

  const { agentId, pid } = await server.spawnOnDaemon(daemon.daemonId, {
    command: recipe.command,
    cwd: recipe.cwd,
    autoRestart: recipe.autoRestart,
  });

  // Briefly wait for the just-spawned agent's WS handshake to complete
  // so callers can immediately rely on `getConnection().status === 'connected'`.
  // Don't fail if it doesn't — the caller has its own connection check
  // and will surface a more contextual error.
  await waitForAgentConnection(agentId, 3000);

  // Race note: if the daemon was re-forked between `readActiveDaemon`
  // above and this `set`, we may persist a `daemonId` that no longer
  // matches `activeDaemonId`. That's intentional and self-healing — the
  // daemonId-match check at the top of the next call rejects the stale
  // entry and falls through to a fresh spawn, which then overwrites it.
  // We never need to lock around the write, and callers never observe
  // an agent from a dead daemon.
  threadToAgent.set(threadKey, {
    agentletAgentId: agentId,
    pid,
    daemonId: daemon.daemonId,
  });
  return { agentletAgentId: agentId, pid };
}

/**
 * Drop the cached mapping for `threadKey` and best-effort ask the
 * daemon to stop the spawned agent. Called when a thread is deleted.
 * Leaving a zombie agent process behind is acceptable (the daemon
 * will reap it on its own shutdown) but wasteful, so we make a
 * best-effort stop request and swallow any error.
 */
export async function releaseThread(threadKey: string): Promise<void> {
  const cached = threadToAgent.get(threadKey);
  threadToAgent.delete(threadKey);
  if (!cached) return;
  const server = getAgentletServer();
  if (!server) return;
  try {
    await server.stopOnDaemon(cached.daemonId, {
      agentId: cached.agentletAgentId,
    });
  } catch {
    // Best-effort: a dying daemon, already-stopped agent, or unknown
    // id are all acceptable here. Caller already removed the thread.
  }
}

/** Test-only: clear the cache between vitest cases. */
export function _resetSpawnOrchestratorForTests(): void {
  threadToAgent.clear();
  activeDaemonId = null;
}
