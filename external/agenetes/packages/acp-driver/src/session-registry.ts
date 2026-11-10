/**
 * Per-process registry of live ACP sessions, keyed by device and the full
 * namespace/thread identity shared with the Agenetes runtime.
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
 *     agentlet `onDisconnection` callback in `@agenetes/agentlet-host` to evict
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

import { threadIdentityKey } from '@agenetes/runtime';

import type { AcpBindingRecipe } from './binding-recipe.js';
import type { AcpAgentClient } from './client.js';
import type { Namespace } from '@agenetes/protocol';
import type {
  Cost as AcpCost,
  ModelInfo as AcpModelInfo,
  SessionConfigOption as AcpSessionConfigOption,
  SessionMode as AcpSessionMode,
  AvailableCommand,
} from '@agentclientprotocol/sdk';

/** A single live ACP session owned by one Sediment thread. */
export interface AcpSessionEntry {
  /** Execution node that owns this session. */
  agentletId: string;
  /** Agenetes thread that owns this session. */
  threadId: string;
  /** The shared ACP client that talks to the agentlet `AgentConnection`. */
  client: AcpAgentClient;
  /** ACP session id returned by `session/new`. */
  sessionId: string;
  /**
   * The user-configured profile this session is bound to. Used to
   * detect stale entries when a thread's binding is reassigned to a
   * different profile. The volatile `sessionId` returned by the
   * agentlet's spawn RPC is NOT stored — sessions follow the
   * profile, not the worker process; if the agent is re-spawned
   * (crash + auto-restart, or supervisor re-fork) we transparently
   * try `session/load` against the new agent and only fall back
   * to `session/new` if that fails.
   */
  profileId: string;
  /**
   * Storage / metadata scope for this session (§7 M5.0) — the `Namespace`
   * (`{ name, storage? }`) the session store persists under, and the
   * opaque scope key for the fs sandbox / permission checks. A thread is
   * normally pinned to one scope for its lifetime. Owner/name and legacy
   * storage-root identity match the runtime, so sessions in different scopes
   * coexist without replacing one another. L1 maps its canvasId onto this; the driver treats
   * it opaquely and resolves all on-disk paths from it, so no host path
   * helper is reached. An empty `name` means "no scope" and the fs sandbox
   * rejects any fs/* call in that state.
   */
  namespace: Namespace;
  /** `cwd` passed to `session/new`. Mostly for diagnostics. */
  cwd: string;
  /** Epoch ms at which this session was first created. */
  createdAt: number;
  /**
   * Spawn recipe used to (re)launch the agent for this session.
   * Kept on the entry so the deferred `writeAcpSessionRecord` call
   * on first prompt has everything it needs without re-resolving the
   * profile (which may have been edited mid-session).
   */
  bindingRecipe: AcpBindingRecipe;
  /**
   * Whether this session's `sessionId` has been committed to the
   * per-thread disk record (`session-store`). False for freshly-
   * created sessions until the first user prompt actually goes out
   * — we used to write the record immediately at `session/new`
   * resolve time, but agents like Copilot CLI don't persist a
   * session until at least one prompt arrives, so a server restart
   * mid-thread (no message yet) would replay a stale sessionId via
   * `session/load` and blow up with `Resource not found`. Deferring
   * the write until first prompt removes that trap: empty threads
   * keep no on-disk record, so the next open just creates fresh.
   *
   * True from the start when we're resuming a session that already
   * has a record on disk (we refresh that record at open time so a
   * subsequent restart can recover again).
   */
  persistedToDisk: boolean;
  /**
   * Whether the workload's portable initial preamble has been delivered
   * through ACP's first-ordinary-prompt fallback.
   *
   * The preamble is prepended to the FIRST user `session/prompt` of a
   * freshly-created session rather than sent as a standalone turn (ACP
   * `session/prompt` always elicits a model turn, so a separate send
   * would waste one). It is therefore sent exactly once per blank
   * session and read at prompt-build time to decide whether to include
   * it.
   *
   * False for freshly-created (`session/new`) sessions — they start
   * with no context. True from the start when resuming (`session/load`)
   * an existing session, whose restored transcript already contains the
   * preamble. Flipped to true in the post-success `.then` of the first
   * prompt that actually carried it (so a failed first turn, or a
   * slash-command short-circuit that forwards verbatim, re-sends it on
   * the next real turn).
   */
  initialPreambleDelivered: boolean;
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
   *
   * Carries the AGENT's view of each knob. Copilot CLI reports its
   * process-global user setting here, so `currentValue` is NOT a
   * per-thread answer — see {@link AcpSessionEntry.selections}.
   */
  configOptions: AcpSessionConfigOption[];
  /**
   * Explicit user selections for THIS thread, keyed by config-option id
   * (`mode` / `model` / agent-defined ids like `allow_all`).
   *
   * Written only by a successful set-RPC, never by an agent push, so it
   * survives the global broadcasts that overwrite `configOptions` and
   * `current*`. Authoritative for display and replayed onto the agent
   * when the session is resumed.
   */
  selections: Record<string, string | boolean>;
  /** Epoch ms the selection map was last written by a set-RPC. */
  selectionsUpdatedAt: number;
  /**
   * The in-flight replay of {@link AcpSessionEntry.selections} onto the
   * agent, or `null` once nothing is pending. Anything that must not
   * overtake it — a turn's `session/prompt`, a user's set-RPC — waits on it
   * through `awaitSelectionReplay`.
   */
  selectionsReplay: Promise<void> | null;
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

/** Capture caller-owned namespace data before asynchronous preparation. */
export function captureAcpNamespace(namespace: Namespace): Namespace {
  return Object.freeze({
    ...namespace,
    ...(namespace.storage
      ? { storage: Object.freeze({ ...namespace.storage }) }
      : {}),
  });
}

/** Device transport key; namespace/thread identity has one owner in runtime. */
export function acpTransportKey(
  agentletId: string,
  threadId: string,
  namespace?: Namespace,
): string {
  return JSON.stringify([
    agentletId,
    threadIdentityKey({ threadId, namespace }),
  ]);
}

interface PreparationScope {
  agentletId: string;
  threadId: string;
  namespace?: Namespace;
  pending: Set<Promise<void>>;
  closing: boolean;
}

class AcpSessionRegistry {
  private readonly byPlacementAndThread = new Map<string, AcpSessionEntry>();
  // Startup reservations are not live sessions yet. Keeping them beside the
  // registry makes legacy ambiguity and teardown include that owned work.
  private readonly preparing = new Map<string, PreparationScope>();

  scopes(
    agentletId: string,
    threadId: string,
  ): Map<string, Namespace | undefined> {
    const scopes = new Map<string, Namespace | undefined>();
    for (const [key, entry] of this.byPlacementAndThread) {
      if (entry.agentletId === agentletId && entry.threadId === threadId)
        scopes.set(key, entry.namespace);
    }
    for (const [key, scope] of this.preparing) {
      if (scope.agentletId === agentletId && scope.threadId === threadId)
        scopes.set(key, scope.namespace);
    }
    return scopes;
  }

  private key(
    agentletId: string,
    threadId: string,
    namespace?: Namespace,
  ): string {
    if (namespace) return acpTransportKey(agentletId, threadId, namespace);
    const matches = this.scopes(agentletId, threadId);
    if (matches.size > 1)
      throw new Error(
        `Ambiguous ACP thread '${threadId}'; supply its namespace`,
      );
    return matches.keys().next().value ?? acpTransportKey(agentletId, threadId);
  }

  reservePreparation(
    agentletId: string,
    threadId: string,
    namespace?: Namespace,
  ): () => void {
    const key = acpTransportKey(agentletId, threadId, namespace);
    let scope = this.preparing.get(key);
    if (scope?.closing) throw new Error(`ACP thread '${threadId}' is closing`);
    if (!scope) {
      scope = {
        agentletId,
        threadId,
        namespace,
        pending: new Set(),
        closing: false,
      };
      this.preparing.set(key, scope);
    }
    let settle!: () => void;
    const pending = new Promise<void>((resolve) => {
      settle = resolve;
    });
    scope.pending.add(pending);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      scope.pending.delete(pending);
      settle();
      if (
        !scope.pending.size &&
        !scope.closing &&
        this.preparing.get(key) === scope
      )
        this.preparing.delete(key);
    };
  }

  beginCleanup(agentletId: string, threadId: string, namespace?: Namespace) {
    const key = this.key(agentletId, threadId, namespace);
    let scope = this.preparing.get(key);
    if (!scope) {
      scope = {
        agentletId,
        threadId,
        namespace: namespace ?? this.byPlacementAndThread.get(key)?.namespace,
        pending: new Set(),
        closing: false,
      };
      this.preparing.set(key, scope);
    }
    scope.closing = true;
    return {
      namespace: scope.namespace,
      settled: Promise.all([...scope.pending]),
      release: () => {
        scope.closing = false;
        if (!scope.pending.size && this.preparing.get(key) === scope)
          this.preparing.delete(key);
      },
    };
  }

  isClosing(
    agentletId: string,
    threadId: string,
    namespace?: Namespace,
  ): boolean {
    return (
      this.preparing.get(acpTransportKey(agentletId, threadId, namespace))
        ?.closing === true
    );
  }

  /**
   * Look up one device's captured namespace/thread identity. Omitting the
   * namespace is legacy addressing and requires exactly one live/preparing
   * scope; ambiguity refuses instead of choosing a peer.
   */
  get(
    agentletId: string,
    threadId: string,
    namespace?: Namespace,
  ): AcpSessionEntry | undefined {
    return this.byPlacementAndThread.get(
      this.key(agentletId, threadId, namespace),
    );
  }

  /** Register one captured scope, replacing only that scope's prior session. */
  set(agentletId: string, threadId: string, entry: AcpSessionEntry): void {
    entry.namespace = captureAcpNamespace(entry.namespace);
    const key = acpTransportKey(agentletId, threadId, entry.namespace);
    const prior = this.byPlacementAndThread.get(key);
    if (prior && prior !== entry) {
      prior.client.shutdown('session_replaced');
    }
    this.byPlacementAndThread.set(key, entry);
  }

  /**
   * Drop and shutdown one namespace/thread session. Legacy unqualified removal
   * uses the same live/preparing uniqueness requirement as get().
   * Returns true if an entry was removed.
   */
  remove(agentletId: string, threadId: string, namespace?: Namespace): boolean {
    const key = this.key(agentletId, threadId, namespace);
    const entry = this.byPlacementAndThread.get(key);
    if (!entry) return false;
    entry.client.shutdown('thread_session_removed');
    return this.byPlacementAndThread.delete(key);
  }

  /** Number of live sessions \u2014 used by tests / diagnostics. */
  get size(): number {
    return this.byPlacementAndThread.size;
  }

  hasPendingPermissions(
    threadId: string,
    namespace: Namespace | string,
  ): boolean {
    const matches = [...this.byPlacementAndThread.values()].filter(
      (entry) =>
        entry.threadId === threadId &&
        (typeof namespace === 'string'
          ? entry.namespace.name === namespace
          : threadIdentityKey(entry) ===
            threadIdentityKey({ threadId, namespace })),
    );
    if (typeof namespace === 'string') {
      const identities = new Set(
        matches.map((entry) => threadIdentityKey(entry)),
      );
      for (const scope of this.preparing.values()) {
        if (scope.threadId === threadId && scope.namespace?.name === namespace)
          identities.add(
            threadIdentityKey({ threadId, namespace: scope.namespace }),
          );
      }
      if (identities.size > 1)
        throw new Error(
          `Ambiguous ACP thread '${threadId}'; supply its namespace`,
        );
    }
    return matches.some((entry) =>
      entry.client.hasPendingPermissions(entry.sessionId),
    );
  }
}

/** Process-wide singleton. */
export const acpSessionRegistry = new AcpSessionRegistry();
