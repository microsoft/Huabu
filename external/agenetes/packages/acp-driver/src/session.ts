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
 * family + snapshot/hydrate/seed/schedule/promote) own the ACP-SDK-shaped
 * control-plane state — modes / models / config-options / slash-command
 * catalogue / usage / title — that `control` mutates and that is persisted
 * (debounced) to the session store for cross-restart recovery.
 *
 * Host-agnostic: storage scope arrives as a `Namespace` on the options /
 * entry (L1 maps its canvasId → namespace); the agent reachback env is
 * L1-assembled and handed in on `env`; the profile-schema cache is an
 * injected {@link AcpProfileCachePort} (L1 owns the projection). This
 * module never reads a host port, assembles an RFS URL, or imports
 * `@sediment/shared`. See docs/proposals/layered-architecture.md §7 (M5).
 */

import { getAgentletServer } from '@agenetes/agentlet-host';

import { AcpAgentClient } from './client.js';
import { AcpServiceError } from './errors.js';
import { acpSessionRegistry } from './session-registry.js';
import {
  deleteAcpSessionRecord,
  readAcpSessionRecord,
  writeAcpSessionMeta,
  writeAcpSessionRecord,
} from './session-store.js';
import { ensureAgentForThread } from './spawn-orchestrator.js';

import type { AcpInitializeResult } from './client.js';
import type { AcpSessionEntry } from './session-registry.js';
import type {
  AcpBindingRecipe,
  AcpSessionPersistedMeta,
} from './session-store.js';
import type { Namespace } from '@agenetes/protocol';
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
// and this module only emits into / reads from the port. When no port is
// installed (e.g. a unit test) every call is a silent no-op / cache miss.
// See docs/proposals/layered-architecture.md §7 (M3).
export interface AcpProfileCachePort {
  /**
   * Mirror a live session entry's schema + last-known state into the
   * cross-thread, on-disk profile cache. Called after any out-of-turn meta
   * update that changes a profile-shared field (mode / model / config /
   * slash-command catalogue). L1 owns the projection + persistence.
   */
  mirror(entry: AcpSessionEntry): void;
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

// ─── Session lifecycle helper ─────────────────────────────────────────────

export interface EnsureAcpSessionOptions {
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
   * Pre-resolved spawn recipe for a first-time thread (no persisted
   * `bindingRecipe` yet). The host composition layer resolves this from
   * its profile store *before* calling in, so the session-lifecycle code
   * never reaches back into an L1 module (`profile-store`). For a
   * returning thread the persisted `bindingRecipe` snapshot wins and this
   * is ignored; when both are absent the binding is unbound and the call
   * throws. Carrying the recipe on the options (rather than looking it up
   * here) is what makes the create-time spec fully serializable.
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
  logger: AcpSessionLogger;
}

/**
 * Per-key map of in-flight `ensureAcpSession` work, used to coalesce
 * concurrent callers so we never run `initialize() + session/new`
 * twice for the same `{threadId, profileId, scopeName}` triple.
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
 * Keying by all three staleness inputs means: different profile / scope
 * / thread → independent slots, so a binding switch is never blocked
 * waiting on a stale promise.
 */
const inflightEnsureSessions = new Map<string, Promise<AcpSessionEntry>>();

function ensureSessionKey(
  threadId: string,
  profileId: string,
  scopeName: string,
): string {
  return `${threadId}|${profileId}|${scopeName}`;
}

/**
 * Per-`(scopeName, threadId)` debounce slots for meta persistence. Meta
 * updates can arrive in bursts (e.g. an `available_commands_update`
 * immediately followed by a `config_option_update` on session warm-up,
 * or a flurry of `usage_update`s during a long turn), and persisting
 * each one independently would hit the JSON store dozens of times per
 * second on a busy thread. We collapse them into a single tail-write
 * by deferring the flush by {@link META_PERSIST_DEBOUNCE_MS}.
 *
 * Cancellation: callers MUST invoke `cancelPersistEntryMeta` whenever
 * the record is being deleted (binding switch, scope switch, load
 * failure) — otherwise a queued timer could re-create the file
 * milliseconds after a deliberate `deleteAcpSessionRecord` call.
 */
const META_PERSIST_DEBOUNCE_MS = 250;
const pendingMetaPersists = new Map<string, NodeJS.Timeout>();

function metaPersistKey(scopeName: string, threadId: string): string {
  return `${scopeName}|${threadId}`;
}

function snapshotEntryMeta(entry: AcpSessionEntry): AcpSessionPersistedMeta {
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
 * Hydrate a fresh registry entry from a previously-persisted meta
 * snapshot. Used by the "already loaded" recovery path where neither
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
  meta: AcpSessionPersistedMeta,
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
 * validated defensively. Called BEFORE {@link replayEventStoreMeta} so a
 * genuinely-newer replayed notification still overrides this seed.
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
  // Propagate the schema to the per-profile cache so sibling threads of
  // the same profile resolve `/cached-meta` without re-spawning. L1 owns
  // the cache; we only emit into the injected port.
  profileCachePort?.mirror(entry);
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
 * Schedule (or reschedule) a debounced write of the entry's current
 * meta snapshot to disk. Safe to call from notification handlers on
 * the hot path — the actual write happens asynchronously and never
 * throws (failures are logged and swallowed; we never want a
 * persistence hiccup to kill an SSE stream).
 *
 * No-op when the entry has an empty scope (`namespace.name` — anonymous
 * threads are not persisted at all — see `writeAcpSessionRecord`).
 */
function schedulePersistEntryMeta(
  entry: AcpSessionEntry,
  logger: AcpSessionLogger,
): void {
  if (!entry.namespace.name) return;
  const threadId = findThreadIdForEntry(entry);
  if (!threadId) return;
  const key = metaPersistKey(entry.namespace.name, threadId);
  const prior = pendingMetaPersists.get(key);
  if (prior) clearTimeout(prior);
  const timer = setTimeout(() => {
    pendingMetaPersists.delete(key);
    try {
      writeAcpSessionMeta(
        entry.namespace,
        threadId,
        snapshotEntryMeta(entry),
      );
    } catch (err) {
      logger.warn(
        {
          threadId,
          scopeName: entry.namespace.name,
          err: err instanceof Error ? err.message : String(err),
        },
        '[acp] failed to persist session meta snapshot (will retry on next update)',
      );
    }
  }, META_PERSIST_DEBOUNCE_MS);
  // `unref` so a stale pending timer never blocks process shutdown.
  if (typeof timer.unref === 'function') timer.unref();
  pendingMetaPersists.set(key, timer);
}

function cancelPersistEntryMeta(scopeName: string, threadId: string): void {
  if (!scopeName) return;
  const key = metaPersistKey(scopeName, threadId);
  const prior = pendingMetaPersists.get(key);
  if (prior) {
    clearTimeout(prior);
    pendingMetaPersists.delete(key);
  }
}

/**
 * One-shot promotion of a freshly-opened ACP session to the on-disk
 * record. Called after the FIRST successful `session/prompt` on a
 * thread — see {@link AcpSessionEntry.persistedToDisk} for the full
 * rationale. No-op when the entry is already persisted, when it has
 * an empty scope (`namespace.name` — anonymous threads aren't persisted),
 * or when the reverse lookup fails (entry already removed).
 *
 * Failures are logged and swallowed: missing the promotion just
 * means the user has to re-open the thread on the next server
 * restart, which is the pre-fix behaviour anyway.
 */
export function promoteEntryToPersisted(
  entry: AcpSessionEntry,
  logger: AcpSessionLogger,
): void {
  if (entry.persistedToDisk) return;
  if (!entry.namespace.name) return;
  const threadId = findThreadIdForEntry(entry);
  if (!threadId) return;
  try {
    writeAcpSessionRecord(entry.namespace, threadId, {
      sessionId: entry.sessionId,
      profileId: entry.profileId,
      cwd: entry.cwd,
      bindingRecipe: entry.bindingRecipe,
      meta: snapshotEntryMeta(entry),
    });
    entry.persistedToDisk = true;
  } catch (err) {
    logger.warn(
      {
        threadId,
        scopeName: entry.namespace.name,
        err: err instanceof Error ? err.message : String(err),
      },
      '[acp] failed to persist session record on first-prompt promotion (recovery after restart will fall back)',
    );
  }
}

/**
 * Reverse-lookup the threadId for a registry entry. The registry maps
 * threadId → entry but the entry itself doesn't carry the threadId
 * (it would be redundant in normal flow). We need it here because the
 * persistence layer is keyed by `(scopeName, threadId)`.
 *
 * Linear scan over O(threads-on-this-server) — acceptable: a single
 * Sediment server typically holds a handful of live ACP sessions, and
 * this only runs on the (debounced) meta-persist path.
 */
function findThreadIdForEntry(entry: AcpSessionEntry): string | null {
  for (const [threadId, candidate] of acpSessionRegistry.entries()) {
    if (candidate === entry) return threadId;
  }
  return null;
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
  const { threadId, binding, logger } = opts;
  const namespace = opts.namespace;
  const scopeName = namespace.name;
  const persisted = readAcpSessionRecord(
    namespace,
    threadId,
  );

  // Recipe-first resolution:
  //   1. Trust the persisted `bindingRecipe` snapshot (returning thread —
  //      profile mutations / deletions after thread creation must NOT
  //      reach the running agent).
  //   2. Fall back to the host-resolved recipe passed on the options
  //      (first-time thread, or legacy v2 record without a recipe). The
  //      host resolves this from its profile store before calling in; we
  //      then snapshot it onto the record below so subsequent calls hit
  //      (1). This keeps the session-lifecycle code free of any L1
  //      profile-store dependency.
  //   3. If neither is available, the binding is unbound — fail with a
  //      clear, user-actionable error.
  const recipe: AcpBindingRecipe | null =
    persisted?.bindingRecipe ?? opts.recipe ?? null;
  if (!recipe) {
    throw new AcpServiceError(
      'profile_missing',
      `External agent '${binding.alias}' is no longer configured. Re-create the profile in Settings → External Agents, or start a new chat with another agent.`,
    );
  }
  const cwd = opts.cwd ?? recipe.cwd ?? recipe.agentTeam?.agentDir ?? '';

  const server = getAgentletServer();
  if (!server) {
    throw new AcpServiceError(
      'bridge_not_mounted',
      'ACP bridge is not mounted \u2014 the embedded agentlet daemon is not running yet',
    );
  }

  // Resolve the thread to a live agentlet agent. Each thread owns its
  // own CLI process — the orchestrator either returns the cached spawn
  // or asks the daemon to start a new one keyed on `threadId`.
  // When a persisted sessionId exists, pass it to the orchestrator so
  // the daemon can resume a suspended session instead of creating new.
  // Failures here surface as a 503 from the caller with a user-actionable
  // hint pointing at Settings → External Agents.
  const { sessionId: agentSessionId } = await ensureAgentForThread(
    threadId,
    recipe,
    persisted?.sessionId,
    opts.env,
  );
  const conn = server.getConnection(agentSessionId);
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

  let entry = acpSessionRegistry.get(threadId);
  if (entry && entry.namespace.name !== scopeName) {
    logger.info(
      {
        threadId,
        oldScopeName: entry.namespace.name,
        newScopeName: scopeName,
      },
      '[acp] thread scope changed \u2014 discarding stale session (sandbox scope mismatch)',
    );
    cancelPersistEntryMeta(entry.namespace.name, threadId);
    acpSessionRegistry.remove(threadId);
    // Persisted record is scope-namespaced (see session-store path layout),
    // so the wrong-scope case is already handled implicitly. We still
    // proactively drop the OLD scope's record to keep the store tidy.
    deleteAcpSessionRecord(entry.namespace, threadId);
    entry = undefined;
  }
  if (entry && entry.client.isClosed) {
    logger.info(
      { threadId },
      '[acp] stored session client was closed \u2014 reopening',
    );
    cancelPersistEntryMeta(entry.namespace.name, threadId);
    acpSessionRegistry.remove(threadId);
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
  // the DataStore's SessionRecord instead of calling those RPCs again.
  // This fixes the split-brain sessionId divergence where Huabu's
  // second session/new created a different sessionId from the one the
  // WS relay + EventStore are keyed on.

  const client = new AcpAgentClient(conn, { scopeName, logger });

  // Seed initializeResult from the DataStore (persisted by the server
  // on agent/hello). The record contains the agent's capabilities from
  // the daemon's bootstrap — no need to re-initialize.
  const dataStore = server.getDataStore();
  const sessionRecord = dataStore.getSession(agentSessionId);
  if (sessionRecord?.initializeResult) {
    client.seedFromRecord(
      sessionRecord.initializeResult as AcpInitializeResult,
    );
    logger.info(
      {
        threadId,
        sessionId: agentSessionId,
        agentInfo: (sessionRecord.initializeResult as AcpInitializeResult)
          .agentInfo,
      },
      '[acp] seeded client from DataStore (skipped redundant initialize + session/new)',
    );
  } else {
    logger.warn(
      { threadId, sessionId: agentSessionId },
      '[acp] DataStore has no initializeResult for session — agent capabilities unknown',
    );
  }

  const sessionId = agentSessionId;

  const created: AcpSessionEntry = {
    client,
    sessionId,
    profileId: binding.profileId,
    namespace,
    cwd,
    createdAt: Date.now(),
    bindingRecipe: recipe,
    // Resume path (`persisted?.sessionId` was supplied + agent
    // accepted it) already has a valid on-disk record we want to
    // keep alive; refresh it below. Fresh `session/new` sessions
    // start as NOT persisted — the record is created lazily on
    // first user prompt (see `promoteEntryToPersisted`) so an
    // unused thread never leaves a stale sessionId for the next
    // server lifetime to choke on.
    persistedToDisk: !!persisted?.sessionId,
    // Resume-from-disk (`persisted.sessionId` set) means the agent's
    // transcript is restored via `session/load`, so the one-shot system
    // preamble it already received is back in context — mark it sent.
    // A fresh `session/new` starts blank, so the preamble must ride
    // along with this thread's first user prompt (see
    // `AcpSessionEntry.systemPreambleSent` and the preprocessor's
    // `includeSystem`).
    systemPreambleSent: !!persisted?.sessionId,
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

  // Install the long-lived listener so live session/update notifications
  // (available_commands_update, mode updates, etc.) flow to the entry.
  client.registerSessionListener(sessionId, (update) => {
    handleSessionMetaUpdate(created, update, logger);
  });

  // Seed modes/models/configOptions inline from the agent's `session/new`
  // response (Copilot CLI delivers them here rather than via notifications).
  // Done BEFORE replay so a genuinely-newer notification still wins.
  //
  // Gated on the ABSENCE of a per-thread persisted snapshot: the
  // `session/new` blob is frozen at session-creation time, so its
  // `current*` fields (currentModelId / currentModeId / configOption
  // currentValues) are the agent's defaults from back then. On a fresh
  // session that is exactly right (no user choice exists yet). On RESUME
  // (`persisted.meta` present) those frozen defaults are the STALEST
  // source of `current*` — staler than the user's last selection in
  // `persisted.meta` and staler than any replayed/live notification — so
  // we skip the seed entirely and let `replay` + `hydrateEntryFromPersistedMeta`
  // restore the up-to-date state instead of clobbering it.
  seedEntryFromNewSessionResult(
    created,
    persisted?.meta ? undefined : sessionRecord?.newSessionResult,
    logger,
  );

  // Replay any session/update notifications from EventStore that the
  // agent sent during the daemon's session bootstrap (before Huabu
  // constructed the client). These include modes/models/configOptions/
  // available_commands that would otherwise be lost.
  replayEventStoreMeta(server, sessionId, created, logger);

  // If the persisted Huabu-side record has a meta snapshot (e.g. from
  // a previous server lifetime), use it as a fallback seed — it may
  // carry modes/models/configOptions that the agent doesn't re-push
  // after bootstrap.
  if (persisted?.meta && created.metaUpdatedAt === 0) {
    hydrateEntryFromPersistedMeta(created, persisted.meta);
    logger.info(
      {
        threadId,
        sessionId,
        commandCount: created.availableCommands.length,
        modeCount: created.availableModes.length,
      },
      '[acp] hydrated session meta from persisted snapshot (fallback)',
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

  acpSessionRegistry.set(threadId, created);

  // Refresh the on-disk record ONLY when we're resuming a session
  // that already has a record (so the next restart can recover it
  // again). For fresh sessions we defer this write to first prompt
  // — see the field doc for `AcpSessionEntry.persistedToDisk` and
  // the `promoteEntryToPersisted` helper above.
  if (created.persistedToDisk) {
    try {
      writeAcpSessionRecord(namespace, threadId, {
        sessionId,
        profileId: binding.profileId,
        cwd,
        bindingRecipe: recipe,
        meta: snapshotEntryMeta(created),
      });
    } catch (err) {
      logger.warn(
        {
          threadId,
          scopeName,
          err: err instanceof Error ? err.message : String(err),
        },
        '[acp] failed to refresh persisted session record (recovery after restart will fall back)',
      );
    }
  }

  return created;
}

/**
 * Replay `session/update` notifications from the EventStore that arrived
 * during the daemon's session bootstrap (before Huabu constructed the
 * AcpAgentClient). This catches modes, models, configOptions, and
 * available_commands that the agent pushed in response to `session/new`.
 */
function replayEventStoreMeta(
  server: NonNullable<ReturnType<typeof getAgentletServer>>,
  sessionId: string,
  entry: AcpSessionEntry,
  logger: AcpSessionLogger,
): void {
  const eventStore = server.getEventStore();
  let replayed = 0;
  try {
    const events = eventStore.getEventsSince(sessionId, 0);
    for (const ev of events) {
      if (ev.dir !== 'agent') continue;
      const msg = ev.event as unknown as Record<string, unknown>;
      if (msg.method !== 'session/update') continue;
      const params = msg.params as
        | { update?: AcpSessionUpdate }
        | null
        | undefined;
      const update = params?.update;
      if (update && typeof update === 'object' && 'sessionUpdate' in update) {
        handleSessionMetaUpdate(entry, update as AcpSessionUpdate, logger);
        replayed++;
      }
    }
  } catch (err) {
    logger.warn(
      { sessionId, err: err instanceof Error ? err.message : String(err) },
      '[acp] failed to replay EventStore meta — UI selectors may start empty',
    );
  }
  if (replayed > 0) {
    logger.info(
      { sessionId, replayed },
      '[acp] replayed session/update events from EventStore for meta seeding',
    );
  }
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
      profileCachePort?.mirror(entry);
      return;
    case 'config_option_update':
      applyConfigOptionUpdate(entry, update, logger);
      profileCachePort?.mirror(entry);
      return;
    case 'current_mode_update':
      applyCurrentModeUpdate(entry, update, logger);
      profileCachePort?.mirror(entry);
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
  schedulePersistEntryMeta(entry, logger);
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
  schedulePersistEntryMeta(entry, logger);
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
  schedulePersistEntryMeta(entry, logger);
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
  schedulePersistEntryMeta(entry, logger);
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
  schedulePersistEntryMeta(entry, logger);
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
