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
 * In-memory only; no persistence across server restarts. A companion
 * disk store (`session-store.ts`) persists `(canvasId, threadId) →
 * sessionId` so `ensureAcpSession` can recover the ACP session via
 * `session/load` after a restart, preserving the external agent's
 * memory. The first prompt on each thread after a restart triggers
 * that recovery; if `session/load` fails (e.g. agent itself was
 * restarted) we fall back to `session/new` and Sediment's own chat
 * history (loaded via `loadContext`) remains the source of truth for
 * what the user sees.
 */

import type { AcpAgentClient } from './client.js';
import type {
  AcpCost,
  AcpModelInfo,
  AcpSessionConfigOption,
  AcpSessionMode,
  AvailableCommand,
} from '@sediment/shared';

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
  /**
   * Catalogue of selectable modes published by the agent via the
   * `session/new` (or `session/load`) response's `modes` field.
   * `current_mode_update` notifications only carry `currentModeId`,
   * so the list itself is seeded once at session creation time and
   * left untouched until the session is rebuilt.
   */
  availableModes: AcpSessionMode[];
  /**
   * Currently-active mode id. Seeded from `modes.currentModeId` on
   * session creation; subsequently updated by `current_mode_update`
   * notifications and by successful `setSessionMode` calls.
   */
  currentModeId: string | null;
  /**
   * Catalogue of selectable models (experimental ACP capability).
   * Same seeding rules as `availableModes` — there is no
   * dedicated update notification, so the list is fixed at
   * session creation time.
   */
  availableModels: AcpModelInfo[];
  /**
   * Currently-active model id. Seeded from `models.currentModelId`
   * and refreshed by successful `setSessionModel` calls.
   */
  currentModelId: string | null;
  /**
   * Free-form configuration knobs surfaced as UI selectors (Copilot
   * publishes four: model / mode / thought-level / auto-approve).
   * Updated wholesale by `config_option_update` notifications and
   * also returned by `setSessionConfigOption`.
   */
  configOptions: AcpSessionConfigOption[];
  /**
   * Last `session_info_update` payload — title + activity stamp.
   * `null` until the agent pushes one.
   */
  sessionInfo: { title: string | null; updatedAt: string | null } | null;
  /**
   * Last `usage_update` payload — context-window / cost gauge.
   * `null` until the agent pushes one.
   */
  usage: { used: number; size: number; cost: AcpCost | null } | null;
  /**
   * Epoch ms of the most recent meta touch (any of the five fields
   * above). UI uses this to detect stale snapshots after reconnect.
   */
  metaUpdatedAt: number;
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
