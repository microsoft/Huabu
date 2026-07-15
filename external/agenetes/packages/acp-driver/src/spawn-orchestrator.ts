/**
 * Spawn orchestration between per-thread binding recipes and the
 * embedded agentlet.
 *
 * The host-facing model is a list of long-lived "agent profiles"
 * (cli + cwd + flags) which the UI uses as templates when creating
 * new threads. Once a thread is opened, it carries its OWN snapshot
 * of the recipe (see `AcpBindingRecipe` in `session-store.ts`) and
 * is fully decoupled from the originating profile.
 *
 * The agentlet-facing model is a pool of live agent sessions addressed
 * by `sessionId`. This module bridges the two:
 *
 *   `ensureAgentForThread(agentletId, threadId, recipe, existingSessionId?, env?)`
 *     → returns `{agentletId, sessionId, pid}` for the explicitly targeted node
 *       that thread, spawning a new one on the agentlet if none is
 *       alive. Each thread gets its OWN CLI process; we do not share
 *       processes across threads.
 *
 *   `releaseThread(agentletId, threadId)`
 *     → drop the cached mapping and best-effort ask the agentlet to
 *       stop the spawned agent. Used when a thread is deleted.
 *
 * Caching: the map lives in this process's memory and is keyed by
 * `(agentletId, threadId)`, so reconnecting one daemon cannot invalidate
 * or alias sessions owned by another execution node.
 *
 * Session lifecycle: sessions are NOT eagerly destroyed. The agentlet
 * daemon auto-suspends idle sessions after `idleTimeoutSecs` and can
 * resume them when the user revisits the thread.
 *
 * Host-agnostic: the agent reachback env (Sediment's `HUABU_RFS_URL` /
 * `HUABU_THREAD_ID`) is assembled entirely by L1 and handed in on `env`;
 * this module passes it straight through to the agentlet spawn call and
 * neither reads a host port nor interprets any entry. The transport's
 * own `AGENTLET_SERVER` / `AGENTLET_TOKEN` are added by the agentlet
 * daemon, not here.
 */

import {
  AgentletRequestError,
  getDaemonSupervisor,
  getAgentletGateway,
  getSupervisedAgentletId,
} from '@agenetes/agentlet-host';

import { AcpServiceError } from './errors.js';

import type { AcpBindingRecipe } from './binding-recipe.js';

export function isSessionResumeUnavailableError(error: unknown): boolean {
  if (!(error instanceof AgentletRequestError)) return false;
  if (!error.data || typeof error.data !== 'object') return false;
  return (
    (error.data as { code?: unknown }).code === 'session_resume_unavailable'
  );
}

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

/** @deprecated Use threadId directly — kept for backwards compat during migration. */
export function threadKey(_canvasId: string, threadId: string): string {
  return threadId;
}

function agentletThreadKey(agentletId: string, threadId: string): string {
  return JSON.stringify([agentletId, threadId]);
}

/** Resolve one explicitly targeted execution node. */
function readTargetAgentlet(agentletId: string): { agentletId: string } | null {
  const gateway = getAgentletGateway();
  if (!gateway) return null;
  const agentlet = gateway.getAgentlet(agentletId);
  return agentlet?.status === 'connected' ? { agentletId } : null;
}

/**
 * Poll {@link readTargetAgentlet} until the target agentlet is online or
 * `timeoutMs` elapses. Returns the resolved descriptor or `null` on
 * timeout (or as soon as the supervisor has stopped trying).
 */
async function waitForTargetAgentlet(
  agentletId: string,
  timeoutMs: number,
): Promise<{ agentletId: string } | null> {
  const deadline = Date.now() + timeoutMs;
  const supervisor = getDaemonSupervisor();
  const supervisedAgentletId = getSupervisedAgentletId();
  let agentlet = readTargetAgentlet(agentletId);
  while (!agentlet && Date.now() < deadline) {
    if (agentletId === supervisedAgentletId && supervisor.hasGivenUp()) {
      return null;
    }
    await new Promise((r) => setTimeout(r, 100));
    agentlet = readTargetAgentlet(agentletId);
  }
  return agentlet;
}

/**
 * Wait for `sessionId` to report `connected` on the server's
 * connection registry, or return null on timeout.
 */
async function waitForAgentConnection(
  agentletId: string,
  sessionId: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const gateway = getAgentletGateway();
    const conn = gateway?.getSession(agentletId, sessionId);
    if (conn?.status === 'connected') return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * Ensure a live agent process exists for `threadId`, spawning (or
 * resuming) one via the agentlet if needed.
 *
 * Each thread gets its OWN process — we never share an agentlet
 * connection across threads, even when the recipes are identical,
 * because the upstream CLI's state (session pool, current model,
 * mode) is per-process and would bleed across threads otherwise.
 *
 * Resume: when `existingSessionId` is provided (from the persisted
 * session store), the spawn request includes it so the agentlet can
 * resume a suspended session via `session/resume` or `session/load`
 * instead of creating a new one. The store only persists a sessionId
 * after the FIRST successful prompt for that thread (see
 * `AcpSessionEntry.persistedToDisk` in `session-registry.ts`), which
 * sidesteps the otherwise-common case where an agent like Copilot CLI
 * doesn't persist empty in-memory sessions across process lifetimes —
 * trying to `session/load` such an id would return `Resource not found`
 * and fail the whole spawn. If a resume still fails for a stored id
 * (e.g. the agent itself was wiped between restarts), the orchestrator
 * surfaces the agentlet error to the caller; the user can drop the
 * thread and start a fresh one.
 *
 * `env` is the L1-assembled agent reachback env (Sediment's
 * `HUABU_RFS_URL` / `HUABU_THREAD_ID`), passed straight through to the
 * spawn call — this module neither builds nor interprets it.
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
 * the same `(agentletId, threadId)` return the same `sessionId` until the agent
 * dies or the agentlet is re-forked.
 */
export async function ensureAgentForThread(
  agentletId: string,
  threadId: string,
  recipe: AcpBindingRecipe,
  existingSessionId?: string,
  env?: Record<string, string>,
  idleTimeoutSecs = 600,
): Promise<{ agentletId: string; sessionId: string; pid: number }> {
  const agentlet = await waitForTargetAgentlet(
    agentletId,
    AGENTLET_READY_TIMEOUT_MS,
  );
  if (!agentlet) {
    const supervisorStatus =
      agentletId === getSupervisedAgentletId()
        ? getDaemonSupervisor().getStatus()
        : null;
    const hint = supervisorStatus?.lastError
      ? ` (${supervisorStatus.lastError})`
      : '';
    throw new AcpServiceError(
      'placement_unavailable',
      `Target agentlet '${agentletId}' is not connected${hint}.`,
    );
  }

  const cacheKey = agentletThreadKey(agentletId, threadId);
  const cached = threadToAgent.get(cacheKey);
  if (cached) {
    const gateway = getAgentletGateway();
    const conn = gateway?.getSession(cached.agentletId, cached.sessionId);
    if (conn && conn.status === 'connected') {
      return {
        agentletId: cached.agentletId,
        sessionId: cached.sessionId,
        pid: cached.pid,
      };
    }
    threadToAgent.delete(cacheKey);
  }

  const gateway = getAgentletGateway();
  if (!gateway) {
    throw new AcpServiceError(
      'bridge_not_mounted',
      'Agentlet Gateway is not mounted',
    );
  }

  // `env` is the L1-assembled reachback env (canvas-scoped RFS URL +
  // thread id). It is passed straight through — this module never reads
  // a host port or interprets any entry. AGENTLET_SERVER / AGENTLET_TOKEN
  // are injected by the daemon itself.
  const spawnEnv = env && Object.keys(env).length > 0 ? env : undefined;

  let sessionId: string;
  let pid: number;
  try {
    const result = await gateway.spawnOnAgentlet(agentlet.agentletId, {
      appId: threadId,
      ...(existingSessionId ? { sessionId: existingSessionId } : {}),
      sessionSpec: {
        ...(recipe.agentTeam
          ? { agentTeam: recipe.agentTeam }
          : { command: recipe.command, cwd: recipe.cwd }),
        autoRestart: recipe.autoRestart,
        idleTimeoutSecs,
        env: spawnEnv,
      },
    });
    sessionId = result.sessionId;
    pid = result.pid;
  } catch (err) {
    if (existingSessionId && isSessionResumeUnavailableError(err)) {
      throw new AcpServiceError(
        'session_resume_unavailable',
        `External agent '${recipe.alias}' can no longer resume session '${existingSessionId}'`,
      );
    }
    // The agentlet RPC itself rejected — typically a bad recipe
    // (command not found, cwd missing) or a daemon-side validation
    // failure. Preserve the daemon's message so the UI can surface
    // the specific reason (e.g. ENOENT path).
    const message = err instanceof Error ? err.message : String(err);
    throw new AcpServiceError(
      'spawn_failed',
      `Failed to spawn external agent '${recipe.alias}': ${message}`,
    );
  }

  // Wait for the agent's WS handshake to complete before reporting
  // success. If the agent never reaches `connected` within the window
  // we surface a `connect_timeout` — the spawn succeeded but the
  // process is silent. Common when the agent is blocked on
  // interactive auth (Copilot OAuth expired) or crashed on startup.
  const connected = await waitForAgentConnection(
    agentlet.agentletId,
    sessionId,
    3000,
  );
  if (!connected) {
    throw new AcpServiceError(
      'connect_timeout',
      `External agent '${recipe.alias}' started but did not respond within 3s. The agent may need to re-authenticate (e.g. Copilot OAuth) or has crashed on startup.`,
    );
  }

  threadToAgent.set(cacheKey, {
    sessionId,
    pid,
    agentletId: agentlet.agentletId,
  });
  return { agentletId: agentlet.agentletId, sessionId, pid };
}

/**
 * Drop the cached mapping for `threadId` and best-effort ask the
 * agentlet to stop the spawned agent. Called when a thread is deleted.
 */
export async function releaseThread(
  agentletId: string,
  threadId: string,
): Promise<void> {
  const key = agentletThreadKey(agentletId, threadId);
  const cached = threadToAgent.get(key);
  threadToAgent.delete(key);
  if (!cached) return;
  const gateway = getAgentletGateway();
  if (!gateway) return;
  try {
    await gateway.stopOnAgentlet(cached.agentletId, {
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
}
