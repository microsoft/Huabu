/**
 * Per-process registry of live ACP sessions, keyed by Sediment threadId.
 *
 * Persistence model: every Sediment chat thread bound to an external
 * agent (`AgentBindingExternal`) owns one long-lived ACP session on
 * that agent. Successive prompts reuse the same sessionId so the agent
 * retains conversation memory.
 *
 * Lifecycle ownership is intentionally minimal:
 *
 *   - Entries are created lazily by `runAcpAgent` (in service.ts) on the
 *     first prompt for a thread.
 *   - Entries are dropped (and their client `shutdown()`'d) when the
 *     binding for a thread changes (defensive \u2014 the UI lock should
 *     prevent this) or when callers explicitly invoke `remove(threadId)`.
 *   - We do NOT (yet) react to agent disconnect events; the next prompt
 *     after a disconnect will fail the connection-status check in
 *     service.ts and surface as an SSE `error`. Future work can hook the
 *     agentlet `onDisconnection` callback in `server-mount.ts` to evict
 *     all sessions for that agentId proactively.
 *
 * In-memory only; no persistence across server restarts. After a restart,
 * the first prompt on each thread reopens a fresh ACP session \u2014 the
 * external agent loses its session memory but Sediment's own chat history
 * (loaded via `loadContext`) is unaffected.
 */

import type { AcpAgentClient } from './client.js';
import type { AvailableCommand } from '@sediment/shared';

/** A single live ACP session owned by one Sediment thread. */
export interface AcpSessionEntry {
  /** The shared ACP client that talks to the agentlet `AgentConnection`. */
  client: AcpAgentClient;
  /** ACP session id returned by `session/new`. */
  sessionId: string;
  /**
   * The agentlet-side agent id this session was created for. Used to
   * detect stale entries when a thread\u2019s binding is reassigned.
   */
  agentletAgentId: string;
  /**
   * Sediment canvasId this session is bound to. A thread is normally
   * pinned to one canvas for its lifetime, but if it ever rebinds to a
   * different canvas we treat it like a binding change and reset the
   * session \u2014 otherwise fs sandbox / permission scope would leak
   * across canvases. Optional because `agentRequestSchema.canvasId`
   * is optional; an empty string means “no canvas” and the fs sandbox
   * (once implemented) will reject any fs/* call in that state.
   */
  canvasId: string;
  /** `cwd` passed to `session/new`. Mostly for diagnostics. */
  cwd: string;
  /** Epoch ms at which this session was first created. */
  createdAt: number;
  /**
   * Latest snapshot of slash commands the agent advertised via
   * `session/update.available_commands_update`. Initialised to `[]`
   * because the push is best-effort: agents that never send the
   * notification simply expose no slash commands to the UI.
   *
   * Per ACP v1 the notification carries the COMPLETE list (not a
   * diff), so each arrival fully replaces this array.
   */
  availableCommands: AvailableCommand[];
  /**
   * Epoch ms of the most recent `available_commands_update` push.
   * `0` means the agent has not yet pushed; the UI uses this to
   * decide whether to do a delayed re-pull (catch late arrivals).
   */
  commandsUpdatedAt: number;
}

class AcpSessionRegistry {
  private readonly byThread = new Map<string, AcpSessionEntry>();

  /** Look up the session bound to `threadId`, if any. */
  get(threadId: string): AcpSessionEntry | undefined {
    return this.byThread.get(threadId);
  }

  /** Register a fresh session for `threadId`. Overwrites any prior entry. */
  set(threadId: string, entry: AcpSessionEntry): void {
    const prior = this.byThread.get(threadId);
    if (prior && prior !== entry) {
      prior.client.shutdown('session_replaced');
    }
    this.byThread.set(threadId, entry);
  }

  /**
   * Drop and shutdown the session bound to `threadId`.
   * Returns true if an entry was removed.
   */
  remove(threadId: string): boolean {
    const entry = this.byThread.get(threadId);
    if (!entry) return false;
    entry.client.shutdown('thread_session_removed');
    return this.byThread.delete(threadId);
  }

  /** Number of live sessions \u2014 used by tests / diagnostics. */
  get size(): number {
    return this.byThread.size;
  }
}

/** Process-wide singleton. */
export const acpSessionRegistry = new AcpSessionRegistry();
