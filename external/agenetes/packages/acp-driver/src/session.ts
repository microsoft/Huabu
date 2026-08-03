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
import { RequestError } from '@agentclientprotocol/sdk';

import { AcpAgentClient } from './client.js';
import { AcpServiceError } from './errors.js';
import { acpSessionRegistry } from './session-registry.js';
import { ensureAgentForThread } from './spawn-orchestrator.js';

import type { AcpBindingRecipe } from './binding-recipe.js';
import type { AcpInitializeResult } from './client.js';
import type { AcpDurableState } from './handle.js';
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
  (snapshot: AgentStateSnapshot<AcpDurableState>) => void
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
  listener: (snapshot: AgentStateSnapshot<AcpDurableState>) => void,
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
  if (acpSessionRegistry.get(entry.agentletId, entry.threadId) !== entry) {
    return;
  }
  stateListeners.get(placementThreadKey(entry.agentletId, entry.threadId))?.(
    snapshotEntryState(entry),
  );
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
   * Idle timeout applied when spawning this session. `0` disables automatic
   * suspension. The host owns the global policy and injects its current value.
   */
  idleTimeoutSecs?: number;
  /**
   * The instance's **down-feed** (I9.7): the durable `AgentStateSnapshot`
   * last persisted for this thread, threaded down from `driver.create`. The
   * session lifecycle resumes its low-level session from
   * `priorState.driverState.sessionId` (via `session/load`) and rehydrates
   * observable metadata from `priorState.metadata` — replacing the old
   * on-disk `readAcpSessionRecord` read entirely. `undefined` for a fresh
   * thread (no durable record yet).
   */
  priorState?: AgentStateSnapshot<AcpDurableState>;
  /**
   * Whether a matching closed live entry may override `priorState` during
   * Handle self-repair. Disabled only for the history fallback after native
   * resume/load has already returned `session_resume_unavailable`.
   */
  repairFromClosedEntry?: boolean;
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
    selections: entry.selections,
    selectionsUpdatedAt: entry.selectionsUpdatedAt,
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
export function snapshotEntryState(
  entry: AcpSessionEntry,
): AgentStateSnapshot<AcpDurableState> {
  return {
    driverState: {
      ...(entry.persistedToDisk
        ? { sessionId: entry.sessionId as SessionId }
        : {}),
      initialPreambleDelivered: entry.initialPreambleDelivered,
    },
    metadata: snapshotEntryMeta(entry),
  };
}

/**
 * Config-option ids that also have a dedicated legacy ACP field
 * (`session/setSessionMode` / `session/setSessionModel`). Agents that
 * publish a `category: 'mode' | 'model'` config option address the same
 * knob through both channels, so we key both onto one selection id.
 */
export const MODE_SELECTION_ID = 'mode';
export const MODEL_SELECTION_ID = 'model';

/**
 * Record an explicit user selection for this thread and up-report it.
 *
 * The only writer of {@link AcpSessionEntry.selections}. Agent pushes
 * deliberately never reach it: for agents whose config options are
 * process-global (Copilot CLI), a broadcast would otherwise replace the
 * user's per-thread choice with "whatever was picked last, anywhere".
 */
export function recordSessionSelection(
  entry: AcpSessionEntry,
  optionId: string,
  value: string | boolean,
): void {
  entry.selections[optionId] = value;
  entry.selectionsUpdatedAt = Date.now();
  if (typeof value === 'string') {
    if (optionId === MODE_SELECTION_ID) entry.currentModeId = value;
    else if (optionId === MODEL_SELECTION_ID) entry.currentModelId = value;
  }
  entry.metaUpdatedAt = entry.selectionsUpdatedAt;
  reportEntryState(entry);
}

/**
 * Restore this thread's remembered selections onto a fresh entry.
 *
 * Deliberately unconditional, unlike {@link hydrateEntryFromPersistedMeta}:
 * that one is gated on `metaUpdatedAt === 0` so a live agent push wins over
 * a stale snapshot, but the gate closes the moment the agent's bootstrap
 * `config_option_update` drains — which it always does, synchronously, when
 * the session listener is installed. Selections are user intent that no
 * agent push can supersede, so they must survive that race.
 *
 * Only `selections` itself is touched: `currentModeId` / `currentModelId`
 * keep carrying the agent's own view so {@link reconcileSessionSelections}
 * can still tell whether the agent already agrees.
 */
function hydrateSelectionsFromPersistedMeta(
  entry: AcpSessionEntry,
  meta: AgentMetadata | undefined,
): void {
  if (!meta?.selections) return;
  entry.selections = { ...meta.selections };
  entry.selectionsUpdatedAt = meta.selectionsUpdatedAt ?? 0;
}

/** @internal Exported for tests. */
export { hydrateSelectionsFromPersistedMeta };

/** The value the agent currently reports for one selectable knob. */
function agentReportedValue(
  entry: AcpSessionEntry,
  optionId: string,
): string | boolean | undefined {
  const option = entry.configOptions.find(
    (o) => String((o as { id?: unknown }).id ?? '') === optionId,
  );
  if (option) {
    return (option as { currentValue?: string | boolean }).currentValue;
  }
  if (optionId === MODE_SELECTION_ID) return entry.currentModeId ?? undefined;
  if (optionId === MODEL_SELECTION_ID) return entry.currentModelId ?? undefined;
  return undefined;
}

/** Route one selection to the channel the agent actually publishes it on. */
function applySelectionToAgent(
  entry: AcpSessionEntry,
  optionId: string,
  value: string | boolean,
): Promise<unknown> {
  const publishedAsConfigOption = entry.configOptions.some(
    (o) => String((o as { id?: unknown }).id ?? '') === optionId,
  );
  if (!publishedAsConfigOption && typeof value === 'string') {
    if (optionId === MODE_SELECTION_ID) {
      return entry.client.setSessionMode(entry.sessionId, value);
    }
    if (optionId === MODEL_SELECTION_ID) {
      return entry.client.setSessionModel(entry.sessionId, value);
    }
  }
  return entry.client.setSessionConfigOption(entry.sessionId, optionId, value);
}

/**
 * JSON-RPC codes on which a replayed selection is permanently unusable and
 * may therefore be forgotten:
 *
 *   • `-32601 method not found` — the agent dropped the channel entirely, so
 *     this knob can never be set again on this binding;
 *   • `-32602 invalid params` — the agent refused the value itself, which is
 *     what a model id retired by an agent upgrade looks like.
 *
 * Every other code is a verdict about the *call*, not the value: `-32603`
 * is an agent-side internal failure and server-defined codes are opaque.
 */
const UNUSABLE_SELECTION_RPC_CODES: ReadonlySet<number> = new Set([
  -32601, -32602,
]);

/**
 * Whether a failed replay proves the remembered value is unusable, as
 * opposed to merely undeliverable right now.
 *
 * The SDK makes this a clean split: an error *response* from the agent is
 * rejected as a {@link RequestError} carrying the agent's JSON-RPC code,
 * while a closed connection, a dead transport or a client-side guard
 * rejects with a plain `Error`. Only the former says anything about the
 * value we tried to set.
 */
function isSelectionUnusable(err: unknown): boolean {
  return (
    err instanceof RequestError && UNUSABLE_SELECTION_RPC_CODES.has(err.code)
  );
}

/**
 * Whether a config option has taken over one of the reserved legacy keys.
 *
 * Renderers decide that a config option covers the mode / model knob by its
 * `category`, not its id, so the moment an agent publishes
 * `{ id: 'model_id', category: 'model' }` the synthesised legacy pill
 * disappears from the toolbar. A `selections.model` recorded before that
 * upgrade then becomes unreachable: invisible in the UI, yet still replayed
 * through `setSessionModel` on every open — overriding whatever the user
 * picks in the config-option pill that replaced it.
 */
function shadowedByConfigOption(
  entry: AcpSessionEntry,
  selectionId: string,
): boolean {
  return entry.configOptions.some((raw) => {
    const option = raw as { id?: unknown; category?: unknown };
    // Same id means this IS the knob, addressed through the modern channel.
    if (String(option.id ?? '') === selectionId) return false;
    return normalizeSelectionKey(option.category) === selectionId;
  });
}

const normalizeSelectionKey = (value: unknown): string =>
  String(value ?? '')
    .trim()
    .toLowerCase();

/**
 * Replay this thread's selections onto a freshly opened session.
 *
 * Resume restores the user's intent locally, but the agent knows nothing
 * about it — for agents with process-global config options it starts the
 * session on whatever was picked last in some other thread. Without this
 * the persisted `allow_all` is remembered yet never honoured, and the
 * first prompt runs under the wrong model.
 *
 * `agentViewIsLive` says whether the entry's agent-reported fields
 * (`currentModeId` / `currentModelId` / `configOptions[].currentValue`)
 * were established by this session's own traffic. They are NOT a reliable
 * mirror of the agent whenever they came off disk instead:
 * `recordSessionSelection` copies a mode/model pick onto `current*`, and
 * the agent echoes a config-option pick back as `currentValue`, so the
 * persisted snapshot contains the USER's last choice wearing the agent's
 * clothes. Diffing against that concludes "the agent already agrees" about
 * a fresh agent still sitting on its defaults, and skips the one push that
 * mattered. So the shortcut is only taken when the view is live; otherwise
 * every remembered knob is pushed, which is idempotent and off the
 * critical path.
 *
 * Fire-and-forget: a knob the agent cannot accept must not block the first
 * prompt. A value the agent *rejects* (see {@link isSelectionUnusable}) is
 * forgotten so a retired model id cannot wedge the thread on every open;
 * a value that merely failed to reach the agent is kept, because the
 * selection is durable user intent and a dead socket is no reason to
 * destroy it. A reserved key a config option has taken over is forgotten
 * up front (see {@link shadowedByConfigOption}), since replaying it would
 * fight the pill that replaced it.
 */
async function reconcileSessionSelections(
  entry: AcpSessionEntry,
  logger: AcpSessionLogger,
  { agentViewIsLive }: { agentViewIsLive: boolean },
): Promise<void> {
  let dropped = false;
  let applied = 0;
  let retained = 0;
  let shadowed = 0;

  for (const reserved of [MODE_SELECTION_ID, MODEL_SELECTION_ID]) {
    if (!(reserved in entry.selections)) continue;
    if (!shadowedByConfigOption(entry, reserved)) continue;
    delete entry.selections[reserved];
    shadowed += 1;
    logger.info(
      { sessionId: entry.sessionId, optionId: reserved },
      '[acp] forgot a legacy selection a config option now owns',
    );
  }

  for (const optionId of Object.keys(entry.selections)) {
    // Re-read each knob at its turn rather than trusting the snapshot this
    // loop started from: the wait in `awaitSelectionReplay` is bounded, so
    // a set-RPC can overtake a slow replay, and pushing the pre-click value
    // here would silently revert the choice the user just made.
    const value = entry.selections[optionId];
    if (value === undefined) continue;
    if (agentViewIsLive && agentReportedValue(entry, optionId) === value) {
      continue;
    }
    try {
      await applySelectionToAgent(entry, optionId, value);
      applied += 1;
    } catch (err) {
      const detail = {
        sessionId: entry.sessionId,
        optionId,
        ...(err instanceof RequestError ? { rpcCode: err.code } : {}),
        err: err instanceof Error ? err.message : String(err),
      };
      if (!isSelectionUnusable(err)) {
        retained += 1;
        logger.warn(
          detail,
          '[acp] selection replay failed; keeping it for the next open',
        );
        continue;
      }
      delete entry.selections[optionId];
      dropped = true;
      logger.warn(detail, '[acp] dropped a selection the agent rejected');
    }
  }
  const forgot = dropped || shadowed > 0;
  if (applied === 0 && !forgot) return;
  if (forgot) entry.selectionsUpdatedAt = Date.now();
  entry.metaUpdatedAt = Date.now();
  reportEntryState(entry);
  logger.info(
    { sessionId: entry.sessionId, applied, dropped, retained, shadowed },
    '[acp] replayed per-thread selections onto the resumed session',
  );
}

/** @internal Exported for tests. */
export { reconcileSessionSelections };

/**
 * How long a caller will wait for the selection replay before giving up on
 * it. The replay is one round-trip per remembered knob, so this only bites
 * when the agent is unresponsive — and then proceeding on stale settings
 * beats hanging the turn on an agent that may never answer.
 */
const SELECTION_REPLAY_WAIT_MS = 3_000;

/**
 * Let the session's selection replay finish before acting on the agent.
 *
 * Session open is lazy, so the replay is kicked off by the very turn that
 * needs it and races the `session/prompt` that follows. The first knob is
 * written to the wire before open returns, but the loop is sequential, so
 * every later knob would otherwise land after the prompt — the first turn
 * of a resumed thread runs on the wrong model, or without the auto-approve
 * the user set. A user set-RPC has the mirrored problem: the replay's
 * remembered value could overwrite the choice the user just made.
 *
 * Waiting is bounded. The bound is released only once the first waiter is
 * through: a caller that arrives while another is still waiting must wait
 * too, or the guarantee evaporates for exactly the case it exists for —
 * `run()` holding the prompt while the user clicks a pill, whose set-RPC
 * would then sail past and be reverted by the remembered value landing
 * behind it. Once a waiter has returned, later callers go straight
 * through, so a replay slow enough to hit the bound costs one delayed turn
 * rather than a permanently sluggish thread. A set-RPC that overtakes a
 * timed-out replay this way cannot be reverted by it either, because the
 * replay re-reads each selection at the moment it pushes it.
 */
export async function awaitSelectionReplay(
  entry: AcpSessionEntry,
): Promise<void> {
  const pending = entry.selectionsReplay;
  if (!pending) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pending,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SELECTION_REPLAY_WAIT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    // Cleared here, not on entry: clearing before the await would let a
    // concurrent caller read `null` and overtake the very replay this call
    // is waiting on. Callers overlapping the first waiter each arm their
    // own bound, which is still bounded.
    entry.selectionsReplay = null;
  }
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
 *  - Stored client was shut down → repair from its latest recoverable state.
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
  const agentTeamCwd = recipe.agentTeam
    ? 'workingDirPath' in recipe.agentTeam
      ? recipe.agentTeam.workingDirPath
      : recipe.agentTeam.agentDir
    : undefined;
  const cwd = opts.cwd ?? recipe.cwd ?? agentTeamCwd ?? '';

  const gateway = getAgentletGateway();
  if (!gateway) {
    throw new AcpServiceError(
      'bridge_not_mounted',
      'ACP bridge is not mounted \u2014 the embedded agentlet daemon is not running yet',
    );
  }

  const registeredEntry = acpSessionRegistry.get(agentletId, threadId);
  const entryMatchesRequest =
    registeredEntry?.namespace.name === scopeName &&
    registeredEntry.profileId === binding.profileId;
  if (
    registeredEntry &&
    entryMatchesRequest &&
    !registeredEntry.client.isClosed
  ) {
    logger.debug(
      { threadId, sessionId: registeredEntry.sessionId },
      '[acp] reusing existing session for thread',
    );
    return registeredEntry;
  }

  let priorState = opts.priorState;
  if (
    registeredEntry &&
    entryMatchesRequest &&
    registeredEntry.client.isClosed &&
    opts.repairFromClosedEntry !== false
  ) {
    priorState = snapshotEntryState(registeredEntry);
    logger.info(
      {
        threadId,
        sessionId: priorState.driverState.sessionId,
        persistedToDisk: registeredEntry.persistedToDisk,
      },
      '[acp] stored session client was closed \u2014 repairing from live entry state',
    );
  } else if (registeredEntry && !entryMatchesRequest) {
    logger.info(
      {
        threadId,
        oldScopeName: registeredEntry.namespace.name,
        newScopeName: scopeName,
        oldProfileId: registeredEntry.profileId,
        newProfileId: binding.profileId,
      },
      '[acp] stored session does not match requested scope/profile \u2014 replacing',
    );
  } else if (registeredEntry?.client.isClosed) {
    logger.info(
      { threadId },
      '[acp] bypassing closed session state after native recovery failed',
    );
  }
  const priorSessionId = priorState?.driverState.sessionId;

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
    opts.idleTimeoutSecs,
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
    initialPreambleDelivered:
      priorState?.driverState.initialPreambleDelivered ?? false,
    availableCommands: [],
    commandsUpdatedAt: 0,
    availableModes: [],
    currentModeId: null,
    availableModels: [],
    currentModelId: null,
    configOptions: [],
    selections: {},
    selectionsUpdatedAt: 0,
    selectionsReplay: null,
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

  // Unconditional, and before the listener: the agent's bootstrap push
  // would otherwise close the `metaUpdatedAt === 0` gate below and strand
  // the user's remembered choices.
  hydrateSelectionsFromPersistedMeta(created, priorState?.metadata);

  // Installing the listener synchronously drains Gateway pre-attach messages
  // that AcpAgentClient retained as orphan updates during construction.
  client.registerSessionListener(sessionId, (update) => {
    handleSessionMetaUpdate(created, update, logger);
  });

  // If the down-fed snapshot has a meta payload (e.g. from a previous
  // server lifetime), use it as a fallback seed — it may carry
  // modes/models/configOptions that the agent doesn't re-push after
  // bootstrap.
  //
  // Doing so also means the entry's agent-reported fields are now a disk
  // copy of the user's own last choice rather than anything this agent
  // said, which `reconcileSessionSelections` must not mistake for
  // agreement — hence the flag.
  let agentViewIsLive = true;
  if (priorState?.metadata && created.metaUpdatedAt === 0) {
    hydrateEntryFromPersistedMeta(created, priorState.metadata);
    agentViewIsLive = false;
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

  // Push the restored intent back onto the agent. Not awaited here: a slow
  // agent must not delay session open itself. The handle waits on this
  // before the turn's prompt and before any user set-RPC, so nothing
  // overtakes it. Errors are handled per-selection inside; the catch only
  // guards against an unexpected throw so awaiting is always safe.
  created.selectionsReplay = reconcileSessionSelections(created, logger, {
    agentViewIsLive,
  }).catch((err: unknown) => {
    logger.warn(
      {
        threadId,
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      },
      '[acp] selection replay aborted',
    );
  });

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
