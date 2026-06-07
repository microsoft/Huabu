/**
 * Spawn orchestration between Sediment's per-thread binding recipes
 * and the embedded agentlet.
 *
 * The user-facing model is a list of long-lived "agent profiles"
 * (cli + cwd + flags) which the UI uses as templates when creating
 * new threads. Once a thread is opened, it carries its OWN snapshot
 * of the recipe (see `AcpBindingRecipe` in `session-store.ts`) and
 * is fully decoupled from the originating profile.
 *
 * The agentlet-facing model is a pool of live agent sessions addressed
 * by `sessionId`. This module bridges the two:
 *
 *   `ensureAgentForThread(threadKey, recipe)`
 *     → returns `{sessionId, pid}` for the agent currently hosting
 *       that thread, spawning a new one on the agentlet if none is
 *       alive. Each thread gets its OWN CLI process; we do not share
 *       processes across threads.
 *
 *   `releaseThread(threadKey)`
 *     → drop the cached mapping and best-effort ask the agentlet to
 *       stop the spawned agent. Used when a thread is deleted.
 *
 * Caching: the map lives in this process's memory and is keyed
 * `threadKey → sessionId` where `threadKey = canvasId + ':' + threadId`.
 * An agentlet disconnect invalidates the entire cache because the new
 * agentlet (re-fork by the supervisor) starts with an empty agent pool.
 * We detect the swap by tracking `activeAgentletId` and wiping the map
 * whenever it changes.
 */

import { getDaemonSupervisor } from './daemon-supervisor.js';
import { getAgentletServer } from './server-mount.js';

import type { AcpBindingRecipe } from './session-store.js';

/**
 * Cold-start grace window for the embedded agentlet's WS handshake.
 * Generous on purpose: in packaged Electron builds the very first
 * launch has to pay for ASAR unpack, on-access AV scans of the
 * freshly-extracted Node child binary, and the fork itself — all of
 * which can blow well past a few hundred ms on Windows / macOS
 * Gatekeeper systems. Subsequent launches are usually subsecond
 * because the OS has the files cached.
 *
 * We still short-circuit the wait as soon as the supervisor reports
 * `hasGivenUp()` (agentlet entry missing, repeated crashes, …) so a
 * truly broken install does not make every UI affordance hang for
 * the full window.
 */
const AGENTLET_READY_TIMEOUT_MS = 20_000;

interface CachedAgent {
  sessionId: string;
  pid: number;
  /** Which agentlet instance owns this agent. */
  agentletId: string;
}

const threadToAgent = new Map<string, CachedAgent>();
/**
 * The agentletId we believe is currently connected. Set on every
 * `ensureAgentForThread` call by `readActiveAgentlet`; a change drops
 * the entire cache because the previous agentlet's agents are by
 * definition dead with their parent.
 */
let activeAgentletId: string | null = null;

/** Compose the cache key for a thread on a canvas. */
export function threadKey(canvasId: string, threadId: string): string {
  return `${canvasId}:${threadId}`;
}

/**
 * Resolve the single connected agentlet (we only ever run one) and
 * invalidate the per-thread cache when it has been replaced since
 * the last call. Returns `null` when no agentlet is currently online.
 */
function readActiveAgentlet(): {
  agentletId: string;
} | null {
  const server = getAgentletServer();
  if (!server) return null;
  const live = server.getAgentlets();
  const agentlet = live[0];
  if (!agentlet) return null;
  const id = agentlet.sessionId;
  if (activeAgentletId && activeAgentletId !== id) {
    threadToAgent.clear();
  }
  activeAgentletId = id;
  return { agentletId: id };
}

/**
 * Poll {@link readActiveAgentlet} until an agentlet is online or
 * `timeoutMs` elapses. Returns the resolved descriptor or `null` on
 * timeout (or as soon as the supervisor has stopped trying).
 */
async function waitForActiveAgentlet(
  timeoutMs: number,
): Promise<{ agentletId: string } | null> {
  const deadline = Date.now() + timeoutMs;
  const supervisor = getDaemonSupervisor();
  let agentlet = readActiveAgentlet();
  while (!agentlet && Date.now() < deadline) {
    if (supervisor.hasGivenUp()) return null;
    await new Promise((r) => setTimeout(r, 100));
    agentlet = readActiveAgentlet();
  }
  return agentlet;
}

/**
 * Wait for `sessionId` to report `connected` on the server's
 * connection registry, or return null on timeout.
 */
async function waitForAgentConnection(
  sessionId: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const server = getAgentletServer();
    const conn = server?.getConnection(sessionId);
    if (conn?.status === 'connected') return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * Ensure a live agent process exists for `threadKey`, spawning one
 * via the agentlet if needed.
 *
 * Each thread gets its OWN process — we never share an agentlet
 * connection across threads, even when the recipes are identical,
 * because the upstream CLI's state (session pool, current model,
 * mode) is per-process and would bleed across threads otherwise.
 *
 * Cold-start tolerance: we wait up to {@link AGENTLET_READY_TIMEOUT_MS}
 * for the agentlet to come online and up to 3 s for the freshly-spawned
 * agent to finish its handshake. Only after both windows expire (or the
 * supervisor reports it has given up) do we surface a user-facing error.
 *
 * Throws when:
 *   • the supervisor never brings the agentlet online (truly offline),
 *   • the agentlet RPC for spawn fails.
 *
 * Idempotent within a single agentlet's lifetime — repeat calls for
 * the same `threadKey` return the same `sessionId` until the agent
 * dies or the agentlet is re-forked.
 */
export async function ensureAgentForThread(
  threadKey: string,
  recipe: AcpBindingRecipe,
): Promise<{ sessionId: string; pid: number }> {
  const agentlet = await waitForActiveAgentlet(AGENTLET_READY_TIMEOUT_MS);
  if (!agentlet) {
    const supervisorStatus = getDaemonSupervisor().getStatus();
    const hint = supervisorStatus.lastError
      ? ` (${supervisorStatus.lastError})`
      : '';
    throw new Error(
      `External agent worker is not ready${hint}. Try "Restart worker" in Settings → External Agents.`,
    );
  }

  const cached = threadToAgent.get(threadKey);
  if (cached && cached.agentletId === agentlet.agentletId) {
    const server = getAgentletServer();
    const conn = server?.getConnection(cached.sessionId);
    if (conn && conn.status === 'connected') {
      return {
        sessionId: cached.sessionId,
        pid: cached.pid,
      };
    }
    threadToAgent.delete(threadKey);
  }

  const server = getAgentletServer();
  if (!server) {
    throw new Error('agentlet server is not mounted');
  }

  const { sessionId, pid } = await server.spawnOnAgentlet(agentlet.agentletId, {
    appId: threadKey,
    sessionSpec: {
      command: recipe.command,
      cwd: recipe.cwd,
      autoRestart: recipe.autoRestart,
    },
  });

  await waitForAgentConnection(sessionId, 3000);

  threadToAgent.set(threadKey, {
    sessionId,
    pid,
    agentletId: agentlet.agentletId,
  });
  return { sessionId, pid };
}

/**
 * Drop the cached mapping for `threadKey` and best-effort ask the
 * agentlet to stop the spawned agent. Called when a thread is deleted.
 */
export async function releaseThread(threadKey: string): Promise<void> {
  const cached = threadToAgent.get(threadKey);
  threadToAgent.delete(threadKey);
  if (!cached) return;
  const server = getAgentletServer();
  if (!server) return;
  try {
    await server.stopOnAgentlet(cached.agentletId, {
      sessionId: cached.sessionId,
    });
  } catch {
    // Best-effort: a dying agentlet, already-stopped agent, or unknown
    // id are all acceptable here. Caller already removed the thread.
  }
}

/** Test-only: clear the cache between vitest cases. */
export function _resetSpawnOrchestratorForTests(): void {
  threadToAgent.clear();
  activeAgentletId = null;
}
