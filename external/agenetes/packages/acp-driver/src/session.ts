/**
 * ACP session lifecycle + control-plane meta management.
 *
 * `ensureAcpSession` is the get-or-create for a thread's long-lived ACP
 * session (connection lookup, stale-entry eviction, client seed from the
 * daemon's bootstrap record, `available_commands_update` listener, and
 * meta hydrate/seed/replay). It coalesces concurrent callers via an
 * in-flight map so a warm-up probe and the first user prompt never open
 * the session twice.
 *
 * The session-meta handlers (`handleSessionMetaUpdate` + the `apply*Update`
 * family + `snapshotEntryMeta` / `snapshotEntryState` / hydrate / seed) own
 * the ACP-SDK-shaped control-plane state — modes / models / config-options
 * / slash-command catalogue / usage / title — that `control` mutates. It is
 * no longer persisted here: every mutation calls `entry.reportState()`,
 * the up-report hook the owning handle installs, which pushes the folded
 * `AgentStateSnapshot` up to the Agenetes instance (the sole ThreadStore
 * writer + notification re-emitter, I9.7). Durable recovery state is
 * likewise DOWN-fed on create as `opts.priorState`, not read from disk.
 *
 * Host-agnostic: storage scope arrives as a `Namespace` on the options /
 * entry (L1 maps its canvasId → namespace); the agent reachback env is
 * L1-assembled and handed in on `env`; the profile-schema cache is an
 * injected read-only {@link AcpProfileCachePort} (L1 owns the projection
 * and now feeds it from `notifications()`). This module never reads a host
 * port, assembles an RFS URL, or imports `@sediment/shared`. See
 * docs/proposals/layered-architecture.md §7 (M5).
 */

import { getAgentletGateway } from '@agenetes/agentlet-host';

import { AcpAgentClient } from './client.js';
import { AcpServiceError } from './errors.js';
import { acpSessionRegistry } from './session-registry.js';
import { ensureAgentForThread } from './spawn-orchestrator.js';

import type { AcpBindingRecipe } from './binding-recipe.js';
import type { AcpInitializeResult } from './client.js';
import type { AcpSessionEntry } from './session-registry.js';
import type {
  AgentMetadata,
  AgentStateSnapshot,
  Namespace,
  SessionId,
} from '@agenetes/protocol';
import type {
  ModelInfo as AcpModelInfo,
  SessionConfigOption as AcpSessionConfigOption,
  SessionMode as AcpSessionMode,
  SessionUpdate as AcpSessionUpdate,
  AvailableCommand,
} from '@agentclientprotocol/sdk';

/**
 * Logger port used across the ACP session lifecycle. Wider than
 * `TranslatorLogger` (adds `debug`/`error`) because the `AcpAgentClient`
 * requires the full surface. Fastify's `FastifyBaseLogger` satisfies this
 * structurally, so L1 injects its request/app logger unchanged.
 */
export interface AcpSessionLogger {
  debug: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

// ─── L1 profile-schema-cache port (dependency inversion, M3) ──────────────
//
// The per-profile schema cache (`profile-schema-cache.ts`) is an L1 UX
// concern — its DATA originates in L2 (agent `session/update` pushes) but
// the caching policy + cold-start seeding are L1's. This composition shell
// (destined L2) therefore does NOT import the cache directly; L1 injects an
// implementation of this port at bootstrap (see `profile-cache-port.ts`),
// and this module only reads from the port. When no port is installed (e.g.
// a unit test) every call is a silent cache miss.
//
// The WRITE direction (mirroring a live entry's schema into the cache) is
// no longer a port method: L1 now subscribes to `agenetes.notifications()`
// (I9.7) and folds each up-reported `AgentMetadata` into the cache itself,
// so the only inbound port is the cold-start `readCommands` pull.
// See docs/proposals/layered-architecture.md §7 (M3).
export interface AcpProfileCachePort {
  /**
   * Read the warm-start slash-command list cached for a profile, or `null`
   * when none is cached. Used to paint the `/` menu on a fresh session
   * before the agent's authoritative `available_commands_update` arrives.
   */
  readCommands(profileId: string): {
    availableCommands: AvailableCommand[];
    commandsUpdatedAt: number;
  } | null;
}

let profileCachePort: AcpProfileCachePort | null = null;

/**
 * Install (or clear) the L1 profile-schema-cache port. Called once by the
 * host composition root (`app.ts` via `installAcpProfileCachePort`); pass
 * `null` in tests to reset. See {@link AcpProfileCachePort}.
 */
export function setAcpProfileCachePort(port: AcpProfileCachePort | null): void {
  profileCachePort = port;
}

// ─── Up-report channel (I9.7) ─────────────────────────────────────────────
//
// The instance's per-thread up-report listeners, keyed by placement + threadId. The
// owning `AcpAgentHandle` registers one via `registerAcpStateListener` when
// the Agenetes instance wires it (`handle.onState`), independent of whether
// a `run` is active — so an out-of-turn set-RPC (which resolves an entry
// via `ensureAcpSession` before any prompt) still up-reports its meta
// change. The meta-update handlers push through `reportEntryState`, which
// folds the entry into an `AgentStateSnapshot` and hands it to the listener
// (the instance persists it as the sole ThreadStore writer, then re-emits).
const stateListeners = new Map<
  string,
  (snapshot: AgentStateSnapshot) => void
>();

function placementThreadKey(agentletId: string, threadId: string): string {
  return JSON.stringify([agentletId, threadId]);
}

/**
 * Register (replace) the up-report listener for `threadId`. Returns an
 * unsubscribe that removes it only if it is still the current listener.
 * Called by {@link AcpAgentHandle.onState}.
 */
export function registerAcpStateListener(
  agentletId: string,
  threadId: string,
  listener: (snapshot: AgentStateSnapshot) => void,
): () => void {
  const key = placementThreadKey(agentletId, threadId);
  stateListeners.set(key, listener);
  return () => {
    if (stateListeners.get(key) === listener) {
      stateListeners.delete(key);
    }
  };
}

/**
 * Push the entry's current durable state up to its thread's registered
 * up-report listener (I9.7). No-op when the entry is not (or no longer) in
 * the live registry, or when no listener is registered for its thread — the
 * early replay touches inside `ensureAcpSession` (before the handle wires
 * its listener) are simply folded into the initial report the handle fires
 * once it resolves the entry.
 */
export function reportEntryState(entry: AcpSessionEntry): void {
  if (
    acpSessionRegistry.get(entry.agentletId, entry.threadId) !== entry
  ) {
    return;
  }
  stateListeners
    .get(placementThreadKey(entry.agentletId, entry.threadId))
    ?.(snapshotEntryState(entry));
}

// ─── Session lifecycle helper ─────────────────────────────────────────────

export interface EnsureAcpSessionOptions {
  /** Explicit execution-node placement for this session. */
  agentletId: string;
  threadId: string;
  /** External binding for the thread (see {@link RunAcpAgentOptions.binding}). */
  binding: { alias: string; profileId: string };
  /**
   * `cwd` for `session/new`. When omitted, resolved from the bound
   * profile's `cwd` (see {@link RunAcpAgentOptions.cwd} for the full
   * fallback chain).
   */
  cwd?: string;
  /**
   * Pre-resolved spawn recipe for the thread — the L1-baked recipe that
   * rides the create-time `WorkloadSpec`. Under recipe-first-via-L1 (I9.6,
   * decision R1) L1 owns keeping a returning thread's recipe stable, so the
   * driver forwards this verbatim on every turn and no longer resolves the
   * recipe from a persisted snapshot; when absent the binding is unbound
   * and the call throws. Carrying the recipe on the options (rather than
   * looking it up here) is what makes the create-time spec fully
   * serializable.
   */
  recipe?: AcpBindingRecipe | null;
  /**
   * Storage / metadata scope for this session (§7 M5.0). L1 maps its
   * canvasId → `{ name, storage }`; the driver's session store resolves
   * its on-disk location entirely from this, so the module never derives a
   * path from a host helper.
   */
  namespace: Namespace;
  /**
   * L1-assembled agent reachback env (Sediment's `HUABU_RFS_URL` /
   * `HUABU_THREAD_ID`), passed straight through to the agentlet spawn call.
   * The driver neither builds nor interprets it.
   */
  env?: Record<string, string>;
  /**
   * The instance's **down-feed** (I9.7): the durable `AgentStateSnapshot`
   * last persisted for this thread, threaded down from `driver.create`. The
   * session lifecycle resumes its low-level session from
   * `priorState.sessionId` (via `session/load`) and rehydrates the entry's
   * observable metadata from `priorState.metadata` — replacing the old
   * on-disk `readAcpSessionRecord` read entirely. `undefined` for a fresh
   * thread (no durable record yet).
   */
  priorState?: AgentStateSnapshot;
  logger: AcpSessionLogger;
}

/**
 * Per-key map of in-flight `ensureAcpSession` work, used to coalesce
 * concurrent callers so we never run `initialize() + session/new`
 * twice for the same `{agentletId, threadId, profileId, scopeName}` tuple.
 *
 * Why this matters: the ChatPanel mount fires
 * `POST /api/acp/threads/:id/session` to warm the slash-command cache,
 * and the same thread's first user prompt also goes through
 * `ensureAcpSession` via `runAcpAgent`. If they arrive in the same
 * event-loop tick BOTH callers see `acpSessionRegistry.get()` as
 * undefined, both open a session, and the second `registry.set()`
 * `shutdown()`s the first client — which silently invalidates the
 * first request's listener registration and wastes one round-trip.
 *
 * Keying by all four staleness inputs means: different placement / profile /
 * scope / thread → independent slots, so a binding switch is never blocked
 * waiting on a stale promise.
 */
const inflightEnsureSessions = new Map<string, Promise<AcpSessionEntry>>();

function ensureSessionKey(
  agentletId: string,
  threadId: string,
  profileId: string,
  scopeName: string,
): string {
  return JSON.stringify([agentletId, threadId, profileId, scopeName]);
}

/**
 * Fold the entry's current ACP-SDK-shaped control-plane state into the
 * driver-neutral {@link AgentMetadata} snapshot — the ACP driver's
 * translator (I9.7 / M5.5). The field shapes already align (both reference
 * the ACP SDK zod types), so this is a straight structural projection.
 */
function snapshotEntryMeta(entry: AcpSessionEntry): AgentMetadata {
  return {
    availableCommands: entry.availableCommands,
    commandsUpdatedAt: entry.commandsUpdatedAt,
    availableModes: entry.availableModes,
    currentModeId: entry.currentModeId,
    availableModels: entry.availableModels,
    currentModelId: entry.currentModelId,
    configOptions: entry.configOptions,
    sessionInfo: entry.sessionInfo,
    usage: entry.usage,
    metaUpdatedAt: entry.metaUpdatedAt,
  };
}

/**
 * Fold the entry into the full durable {@link AgentStateSnapshot} the
 * handle up-reports (I9.7). The `sessionId` is included ONLY once the
 * session is genuinely recoverable — i.e. after the first successful
 * prompt has flipped `persistedToDisk` (or on a resumed session, which
 * starts persisted). Before that, an agent like Copilot CLI has not yet
 * committed the session, so persisting its `sessionId` would make a
 * restart replay a `session/load` that fails with `Resource not found`;
 * omitting it lets the next lifetime start fresh while still keeping any
 * seeded `metadata` warm.
 */
export function snapshotEntryState(entry: AcpSessionEntry): AgentStateSnapshot {
  return {
    ...(entry.persistedToDisk
      ? { sessionId: entry.sessionId as SessionId }
      : {}),
    metadata: snapshotEntryMeta(entry),
    initialPreambleDelivered: entry.initialPreambleDelivered,
  };
}

/**
 * Hydrate a fresh registry entry from a down-fed {@link AgentMetadata}
 * snapshot (I9.7). Used by the "already loaded" recovery path where neither
 * `session/new` nor `session/load` provides a meta seed and the agent
 * will not re-emit notifications because it never dropped the session
 * from its own memory.
 *
 * Each field is only restored when the snapshot actually contains it
 * (i.e. the agent had pushed that variant before the server restart),
 * so we never overwrite an explicit empty default with `undefined`.
 */
function hydrateEntryFromPersistedMeta(
  entry: AcpSessionEntry,
  meta: AgentMetadata,
): void {
  if (meta.availableCommands) entry.availableCommands = meta.availableCommands;
  if (typeof meta.commandsUpdatedAt === 'number') {
    entry.commandsUpdatedAt = meta.commandsUpdatedAt;
  }
  if (meta.availableModes) entry.availableModes = meta.availableModes;
  if (meta.currentModeId !== undefined)
    entry.currentModeId = meta.currentModeId;
  if (meta.availableModels) entry.availableModels = meta.availableModels;
  if (meta.currentModelId !== undefined) {
    entry.currentModelId = meta.currentModelId;
  }
  if (meta.configOptions) entry.configOptions = meta.configOptions;
  if (meta.sessionInfo !== undefined) entry.sessionInfo = meta.sessionInfo;
  if (meta.usage !== undefined) entry.usage = meta.usage;
  if (typeof meta.metaUpdatedAt === 'number') {
    entry.metaUpdatedAt = meta.metaUpdatedAt;
  }
}

/**
 * Seed a fresh entry's meta from the agent's `session/new` response.
 *
 * The ACP spec lets an agent inline `models` / `modes` / `configOptions`
 * in the NewSessionResponse instead of (or as well as) pushing them via
 * later `session/update` notifications. Copilot CLI does exactly this,
 * so without reading the blob here the UI shows empty model / mode
 * selectors until the user sends the first prompt.
 *
 * The blob is opaque (persisted verbatim by agentlet), so every field is
 * validated defensively. Called before the live listener is installed so
 * buffered bootstrap notifications drain afterward and override this seed.
 */
function seedEntryFromNewSessionResult(
  entry: AcpSessionEntry,
  newSessionResult: unknown,
  logger: AcpSessionLogger,
): void {
  if (!newSessionResult || typeof newSessionResult !== 'object') return;
  const r = newSessionResult as Record<string, unknown>;
  let seeded = false;

  const models = r.models as Record<string, unknown> | undefined;
  if (models && typeof models === 'object') {
    if (Array.isArray(models.availableModels)) {
      entry.availableModels = models.availableModels as AcpModelInfo[];
      seeded = true;
    }
    if (typeof models.currentModelId === 'string') {
      entry.currentModelId = models.currentModelId;
      seeded = true;
    }
  }

  const modes = r.modes as Record<string, unknown> | undefined;
  if (modes && typeof modes === 'object') {
    if (Array.isArray(modes.availableModes)) {
      entry.availableModes = modes.availableModes as AcpSessionMode[];
      seeded = true;
    }
    if (typeof modes.currentModeId === 'string') {
      entry.currentModeId = modes.currentModeId;
      seeded = true;
    }
  }

  if (Array.isArray(r.configOptions)) {
    entry.configOptions = r.configOptions as AcpSessionConfigOption[];
    seeded = true;
  }

  if (!seeded) return;

  entry.metaUpdatedAt = Date.now();
  // The per-profile schema cache is fed by L1's `notifications()`
  // subscriber (I9.7) now, not a driver-side mirror; the up-report the
  // handle fires after installing `reportState` carries this seeded state
  // up to it. We only stamp `metaUpdatedAt` here.
  logger.info(
    {
      sessionId: entry.sessionId,
      modelCount: entry.availableModels.length,
      modeCount: entry.availableModes.length,
      configCount: entry.configOptions.length,
    },
    '[acp] seeded session meta from session/new response',
  );
}

/**
 * Get-or-create the per-thread ACP session, installing the long-lived
 * `available_commands_update` listener on first creation. Idempotent for
 * a given `{threadId, profileId, scopeName}` triple — repeated calls
 * return the same {@link AcpSessionEntry} without re-issuing `session/new`.
 *
 * Concurrency: thread-safe across overlapping awaits. Multiple calls
 * for the same `{threadId, profileId, scopeName}` key share the
 * same in-flight promise so only one `initialize() + session/new`
 * pair is ever issued for a given coalescing window.
 *
 * Stale-entry rules (mirror the logic previously inlined in
 * `runAcpAgent`):
 *  - Binding switched to a different profile → drop and rebuild.
 *  - Canvas changed → drop (sandbox scope mismatch).
 *  - Stored client was shut down → drop and reopen.
 *
 * Throws synchronously when the agentlet bridge is not mounted or the
 * daemon refuses to spawn the agent — same surface as the inline path
 * so callers can `try`/`catch` uniformly.
 */
export async function ensureAcpSession(
  opts: EnsureAcpSessionOptions,
): Promise<AcpSessionEntry> {
  const key = ensureSessionKey(
    opts.agentletId,
    opts.threadId,
    opts.binding.profileId,
    opts.namespace.name,
  );
  const existing = inflightEnsureSessions.get(key);
  if (existing) return existing;
  // The IIFE's `finally` runs only AFTER the inner `await` suspends,
  // by which time `p` is fully assigned. Plain `delete(key)` is safe
  // because no other caller can replace this slot while we own it:
  // they would short-circuit on `existing` above and never reach
  // `set(key, …)`.
  const p: Promise<AcpSessionEntry> = (async () => {
    try {
      return await ensureAcpSessionInner(opts);
    } finally {
      inflightEnsureSessions.delete(key);
    }
  })();
  inflightEnsureSessions.set(key, p);
  return p;
}

async function ensureAcpSessionInner(
  opts: EnsureAcpSessionOptions,
): Promise<AcpSessionEntry> {
  const { agentletId, threadId, binding, logger } = opts;
  const namespace = opts.namespace;
  const scopeName = namespace.name;
  // Down-feed (I9.7): the durable snapshot the instance read off the
  // ThreadStore and threaded down on create. Its `sessionId` drives resume
  // (`session/load`) and its `metadata` seeds the entry — no on-disk
  // `readAcpSessionRecord` read anymore.
  const priorState = opts.priorState;
  const priorSessionId = priorState?.sessionId;

  // Recipe resolution (recipe-first-via-L1, I9.6 / R1): use the L1-baked
  // recipe that rode the create-time spec verbatim. L1 owns keeping a
  // returning thread's recipe stable; the driver no longer reads a
  // persisted `bindingRecipe`. When absent, the binding is unbound — fail
  // with a clear, user-actionable error.
  const recipe: AcpBindingRecipe | null = opts.recipe ?? null;
  if (!recipe) {
    throw new AcpServiceError(
      'profile_missing',
      `External agent '${binding.alias}' is no longer configured. Re-create the profile in Settings → External Agents, or start a new chat with another agent.`,
    );
  }
  const cwd = opts.cwd ?? recipe.cwd ?? recipe.agentTeam?.agentDir ?? '';

  const gateway = getAgentletGateway();
  if (!gateway) {
    throw new AcpServiceError(
      'bridge_not_mounted',
      'ACP bridge is not mounted \u2014 the embedded agentlet daemon is not running yet',
    );
  }

  // Resolve the thread to a live agentlet agent. Each thread owns its
  // own CLI process — the orchestrator either returns the cached spawn
  // or asks the daemon to start a new one keyed on `threadId`.
  // When a down-fed sessionId exists, pass it to the orchestrator so
  // the daemon can resume a suspended session instead of creating new.
  // Failures here surface as a 503 from the caller with a user-actionable
  // hint pointing at Settings → External Agents.
  const { sessionId: agentSessionId } = await ensureAgentForThread(
    agentletId,
    threadId,
    recipe,
    priorSessionId,
    opts.env,
  );
  const conn = gateway.getSession(agentletId, agentSessionId);
  if (!conn || conn.status !== 'connected') {
    // Agentlet acknowledged the spawn but the agent's own WS session
    // never reached `connected` (or has since dropped). Surfaces the
    // same root cause as a `connect_timeout` from the orchestrator:
    // the agent process is up but not talking — almost always an
    // interactive auth wait (Copilot OAuth) or an immediate crash.
    throw new AcpServiceError(
      'connect_timeout',
      `External agent '${recipe.alias}' is not connected`,
    );
  }

  let entry = acpSessionRegistry.get(agentletId, threadId);
  if (entry && entry.namespace.name !== scopeName) {
    logger.info(
      {
        threadId,
        oldScopeName: entry.namespace.name,
        newScopeName: scopeName,
      },
      '[acp] thread scope changed \u2014 discarding stale session (sandbox scope mismatch)',
    );
    // The durable record is namespace-partitioned in the ThreadStore, so a
    // scope switch already writes under the new namespace and the old
    // record simply lingers unread — the instance (sole store writer) owns
    // any cleanup, not the driver. We only drop the live in-memory entry.
    acpSessionRegistry.remove(agentletId, threadId);
    entry = undefined;
  }
  if (entry && entry.client.isClosed) {
    logger.info(
      { threadId },
      '[acp] stored session client was closed \u2014 reopening',
    );
    acpSessionRegistry.remove(agentletId, threadId);
    entry = undefined;
  }
  if (entry) {
    logger.debug(
      { threadId, sessionId: entry.sessionId },
      '[acp] reusing existing session for thread',
    );
    return entry;
  }

  // ── New session: skip re-initialization ──────────────────────────
  //
  // The agentlet daemon has already bootstrapped the session
  // (initialize + session/new) during spawn. We seed the client from
  // the live session profile instead of calling those RPCs again.
  // This fixes the split-brain sessionId divergence where Huabu's
  // second session/new created a different sessionId from the one the
  // WS relay is keyed on.

  const client = new AcpAgentClient(conn, { scopeName, logger });

  // The live profile carries the daemon's bootstrap results, so the
  // stateless Gateway does not need a DataStore.
  const bootstrapProfile = conn.sessionProfile?.session;
  if (bootstrapProfile?.initializeResult) {
    client.seedFromRecord(
      bootstrapProfile.initializeResult as AcpInitializeResult,
    );
    logger.info(
      {
        threadId,
        sessionId: agentSessionId,
        agentInfo: (bootstrapProfile.initializeResult as AcpInitializeResult)
          .agentInfo,
      },
      '[acp] seeded client from live session profile (skipped redundant initialize + session/new)',
    );
  } else {
    logger.warn(
      { threadId, sessionId: agentSessionId },
      '[acp] live session profile has no initializeResult — agent capabilities unknown',
    );
  }

  const sessionId = agentSessionId;

  const created: AcpSessionEntry = {
    agentletId,
    threadId,
    client,
    sessionId,
    profileId: binding.profileId,
    namespace,
    cwd,
    createdAt: Date.now(),
    bindingRecipe: recipe,
    // Resume path (`priorSessionId` was down-fed + agent accepted it)
    // already has a recoverable session, so the entry starts persisted and
    // the handle's first up-report refreshes the durable record. Fresh
    // `session/new` sessions start NOT persisted — `sessionId` is withheld
    // from the up-reported snapshot (see `snapshotEntryState`) until the
    // first user prompt promotes it, so an unused thread never leaves a
    // stale sessionId for the next server lifetime to choke on.
    persistedToDisk: !!priorSessionId,
    // Delivery is independent from session creation: a command may create
    // and persist a session without consuming the pending preamble.
    initialPreambleDelivered: priorState?.initialPreambleDelivered ?? false,
    availableCommands: [],
    commandsUpdatedAt: 0,
    availableModes: [],
    currentModeId: null,
    availableModels: [],
    currentModelId: null,
    configOptions: [],
    sessionInfo: null,
    usage: null,
    metaUpdatedAt: 0,
  };

  // Seed modes/models/configOptions inline from the agent's `session/new`
  // response (Copilot CLI delivers them here rather than via notifications).
  // Done before attaching the listener so a buffered, genuinely-newer
  // notification drains afterward and wins.
  //
  // Gated on the ABSENCE of a down-fed meta snapshot: the `session/new`
  // blob is frozen at session-creation time, so its `current*` fields
  // (currentModelId / currentModeId / configOption currentValues) are the
  // agent's defaults from back then. On a fresh session that is exactly
  // right (no user choice exists yet). On RESUME (`priorState.metadata`
  // present) those frozen defaults are the STALEST source of `current*` —
  // staler than the user's last selection in `priorState.metadata` and
  // staler than any buffered/live notification — so we skip the seed
  // entirely and let notifications + `hydrateEntryFromPersistedMeta` restore
  // the up-to-date state instead of clobbering it.
  seedEntryFromNewSessionResult(
    created,
    priorState?.metadata ? undefined : bootstrapProfile?.newSessionResult,
    logger,
  );

  // Installing the listener synchronously drains Gateway pre-attach messages
  // that AcpAgentClient retained as orphan updates during construction.
  client.registerSessionListener(sessionId, (update) => {
    handleSessionMetaUpdate(created, update, logger);
  });

  // If the down-fed snapshot has a meta payload (e.g. from a previous
  // server lifetime), use it as a fallback seed — it may carry
  // modes/models/configOptions that the agent doesn't re-push after
  // bootstrap.
  if (priorState?.metadata && created.metaUpdatedAt === 0) {
    hydrateEntryFromPersistedMeta(created, priorState.metadata);
    logger.info(
      {
        threadId,
        sessionId,
        commandCount: created.availableCommands.length,
        modeCount: created.availableModes.length,
      },
      '[acp] hydrated session meta from down-fed snapshot (fallback)',
    );
  }

  // Optimistic slash-command warm-start: if no source so far has
  // populated `availableCommands`, seed from the per-profile L3 cache
  // (populated by previous sessions of the same profile). The agent's
  // authoritative `available_commands_update` overwrites this once it
  // arrives, so any per-session drift self-corrects. Mirrors the
  // optimistic localStorage cache the web client maintains for the
  // same purpose.
  if (created.availableCommands.length === 0 && binding.profileId) {
    const warm = profileCachePort?.readCommands(binding.profileId);
    if (warm) {
      created.availableCommands = warm.availableCommands;
      created.commandsUpdatedAt = warm.commandsUpdatedAt;
      logger.info(
        {
          threadId,
          sessionId,
          count: created.availableCommands.length,
        },
        '[acp] warm-started availableCommands from per-profile cache',
      );
    }
  }

  acpSessionRegistry.set(agentletId, threadId, created);

  // The durable record is refreshed via the up-report channel (I9.7): the
  // owning handle installs `reportState` on this entry the moment it
  // resolves it in `run` and fires an initial report, which persists the
  // resumed session's `sessionId` + seeded `metadata` through the instance
  // (the sole ThreadStore writer). No direct on-disk write here anymore.

  return created;
}

/**
 * Long-lived session listener — handles out-of-turn `session/update`
 * notifications carrying session-scoped metadata.
 *
 * Five variants are recognised, all using REPLACE-semantics:
 *
 *   1. `available_commands_update`  → slash command catalogue.
 *   2. `config_option_update`       → free-form config knobs (model /
 *                                     mode / thought-level / etc).
 *   3. `current_mode_update`        → currently-active mode id; the
 *                                     mode catalogue itself was seeded
 *                                     from `session/new` and is left
 *                                     untouched here.
 *   4. `session_info_update`        → title + activity timestamp.
 *   5. `usage_update`               → context-window + cost gauge.
 *
 * All other variants are forwarded by the translator into the SSE
 * stream and ignored here.
 */
function handleSessionMetaUpdate(
  entry: AcpSessionEntry,
  update: AcpSessionUpdate,
  logger: AcpSessionLogger,
): void {
  switch (update.sessionUpdate) {
    case 'available_commands_update':
      applyAvailableCommandsUpdate(entry, update, logger);
      return;
    case 'config_option_update':
      applyConfigOptionUpdate(entry, update, logger);
      return;
    case 'current_mode_update':
      applyCurrentModeUpdate(entry, update, logger);
      return;
    case 'session_info_update':
      applySessionInfoUpdate(entry, update, logger);
      return;
    case 'usage_update':
      applyUsageUpdate(entry, update, logger);
      return;
    default:
      return;
  }
}

function applyAvailableCommandsUpdate(
  entry: AcpSessionEntry,
  update: AcpSessionUpdate,
  logger: AcpSessionLogger,
): void {
  const raw = (update as { availableCommands?: unknown }).availableCommands;
  if (!Array.isArray(raw)) {
    logger.warn(
      { sessionId: entry.sessionId },
      '[acp] available_commands_update without availableCommands array',
    );
    return;
  }
  // Per spec the list REPLACES (not merges with) any prior state.
  // We do a permissive shape check here so a misbehaving agent can't
  // poison the cache.
  const next: AvailableCommand[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    if (!name) continue;
    const description =
      typeof obj.description === 'string' ? obj.description : '';
    const input = obj.input;
    if (
      input !== undefined &&
      input !== null &&
      !(
        typeof input === 'object' &&
        typeof (input as { hint?: unknown }).hint === 'string'
      )
    ) {
      // Reject malformed input metadata but keep the command name.
      next.push({ name, description, input: null });
      continue;
    }
    next.push({
      name,
      description,
      input:
        input && typeof (input as { hint?: unknown }).hint === 'string'
          ? { hint: (input as { hint: string }).hint }
          : null,
    });
  }
  entry.availableCommands = next;
  entry.commandsUpdatedAt = Date.now();
  // Up-report (I9.7): push the folded snapshot up so the instance
  // persists it (sole ThreadStore writer) and re-emits via notifications().
  reportEntryState(entry);
  logger.info(
    {
      sessionId: entry.sessionId,
      count: next.length,
    },
    '[acp] available_commands_update applied',
  );
}

function applyConfigOptionUpdate(
  entry: AcpSessionEntry,
  update: AcpSessionUpdate,
  logger: AcpSessionLogger,
): void {
  // Two wire shapes observed across agents:
  //   • `{ configOptions: SessionConfigOption[] }`  (Copilot CLI)
  //   • A single `SessionConfigOption` flattened on the update itself
  //     (per the SDK's `ConfigOptionUpdate` zod schema).
  // Accept both: the first wins; otherwise reconstruct from the
  // discriminator + payload keys present.
  const raw = update as Record<string, unknown>;
  const list = Array.isArray(raw.configOptions)
    ? (raw.configOptions as AcpSessionConfigOption[])
    : raw.id || raw.label
      ? [raw as unknown as AcpSessionConfigOption]
      : [];
  if (list.length === 0) {
    logger.warn(
      { sessionId: entry.sessionId },
      '[acp] config_option_update without recognisable payload',
    );
    return;
  }
  // The spec is replace-only for the full snapshot; but the
  // single-item flavour is genuinely a per-option upsert. Merge by id.
  if (Array.isArray(raw.configOptions)) {
    entry.configOptions = list;
  } else {
    const byId = new Map<string, AcpSessionConfigOption>(
      entry.configOptions.map((o) => [String((o as { id: string }).id), o]),
    );
    for (const opt of list) {
      const id = String((opt as { id?: unknown }).id ?? '');
      if (!id) continue;
      byId.set(id, opt);
    }
    entry.configOptions = Array.from(byId.values());
  }
  entry.metaUpdatedAt = Date.now();
  // Up-report (I9.7): push the folded snapshot up so the instance
  // persists it (sole ThreadStore writer) and re-emits via notifications().
  reportEntryState(entry);
  logger.info(
    { sessionId: entry.sessionId, count: entry.configOptions.length },
    '[acp] config_option_update applied',
  );
}

function applyCurrentModeUpdate(
  entry: AcpSessionEntry,
  update: AcpSessionUpdate,
  logger: AcpSessionLogger,
): void {
  const id = (update as { currentModeId?: unknown }).currentModeId;
  if (typeof id !== 'string' || !id) {
    logger.warn(
      { sessionId: entry.sessionId },
      '[acp] current_mode_update without currentModeId',
    );
    return;
  }
  entry.currentModeId = id;
  entry.metaUpdatedAt = Date.now();
  // Up-report (I9.7): push the folded snapshot up so the instance
  // persists it (sole ThreadStore writer) and re-emits via notifications().
  reportEntryState(entry);
  logger.info(
    { sessionId: entry.sessionId, currentModeId: id },
    '[acp] current_mode_update applied',
  );
}

function applySessionInfoUpdate(
  entry: AcpSessionEntry,
  update: AcpSessionUpdate,
  logger: AcpSessionLogger,
): void {
  const raw = update as { title?: unknown; updatedAt?: unknown };
  const title = readNullableString(raw.title);
  const updatedAt = readNullableString(raw.updatedAt);
  if (title === undefined && updatedAt === undefined) {
    logger.warn(
      { sessionId: entry.sessionId },
      '[acp] session_info_update without title or updatedAt',
    );
    return;
  }
  const prior = entry.sessionInfo ?? { title: null, updatedAt: null };
  entry.sessionInfo = {
    title: title === undefined ? prior.title : title,
    updatedAt: updatedAt === undefined ? prior.updatedAt : updatedAt,
  };
  entry.metaUpdatedAt = Date.now();
  // Up-report (I9.7): push the folded snapshot up so the instance
  // persists it (sole ThreadStore writer) and re-emits via notifications().
  reportEntryState(entry);
  logger.info(
    { sessionId: entry.sessionId, info: entry.sessionInfo },
    '[acp] session_info_update applied',
  );
}

function applyUsageUpdate(
  entry: AcpSessionEntry,
  update: AcpSessionUpdate,
  logger: AcpSessionLogger,
): void {
  const raw = update as { used?: unknown; size?: unknown; cost?: unknown };
  const used = typeof raw.used === 'number' ? raw.used : null;
  const size = typeof raw.size === 'number' ? raw.size : null;
  if (used === null || size === null) {
    logger.warn(
      { sessionId: entry.sessionId },
      '[acp] usage_update missing used/size',
    );
    return;
  }
  let cost: { amount: number; currency: string } | null = null;
  if (raw.cost && typeof raw.cost === 'object') {
    const c = raw.cost as { amount?: unknown; currency?: unknown };
    if (typeof c.amount === 'number' && typeof c.currency === 'string') {
      cost = { amount: c.amount, currency: c.currency };
    }
  }
  entry.usage = { used, size, cost };
  entry.metaUpdatedAt = Date.now();
  // Up-report (I9.7): push the folded snapshot up so the instance
  // persists it (sole ThreadStore writer) and re-emits via notifications().
  reportEntryState(entry);
  logger.info(
    { sessionId: entry.sessionId, used, size },
    '[acp] usage_update applied',
  );
}

function readNullableString(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === 'string') return v;
  return undefined;
}
