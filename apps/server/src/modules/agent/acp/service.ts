/**
 * `runAcpAgent` \u2014 the external-binding counterpart of `runAgent`.
 *
 * Drives a single user prompt against an ACP-connected external agent
 * (Copilot / Claude Code / Codex / \u2026) and yields the resulting stream
 * as Sediment\u2019s standard `AgentStreamEvent`s, so the route handler can
 * treat external and internal dispatches uniformly.
 *
 * Persistence model: one ACP session per Sediment thread, kept alive for
 * the thread’s lifetime via {@link acpSessionRegistry}. Successive
 * prompts on the same thread reuse the sessionId so the external agent
 * retains conversation memory.
 *
 * Translation scope today: text deltas only —
 * `session/update.agent_message_chunk` → `text_delta`. Tool calls,
 * plans, thinking, and mode updates are silently dropped by the
 * translator and will be added incrementally.
 */

import { fauxAssistantMessage } from '@earendil-works/pi-ai';

import { AcpAgentClient, type AcpInitializeResult } from './client.js';
import { AcpServiceError } from './errors.js';
import {
  prepareExternalAgentPrompt,
  serializeRawPrompt,
} from './preprocessor.js';
import {
  mergeProfileSchemaCache,
  getProfileSchemaCache,
} from './profile-schema-cache.js';
import { getProfile } from './profile-store.js';
import { getAgentletServer } from './server-mount.js';
import { acpSessionRegistry } from './session-registry.js';
import {
  deleteAcpSessionRecord,
  readAcpSessionRecord,
  writeAcpSessionMeta,
  writeAcpSessionRecord,
} from './session-store.js';
import { ensureAgentForThread } from './spawn-orchestrator.js';
import { acpUpdateToStreamEvent, mergeThinkingChunk } from './translator.js';
import {
  emptySidecar,
  readChatParts,
  recordMessageTimestamp,
  setPlanForMessage,
  upsertToolExt,
  writeChatParts,
} from '../store/chat-parts-store.js';

import type { AcpSessionEntry } from './session-registry.js';
import type {
  AcpBindingRecipe,
  AcpSessionPersistedMeta,
} from './session-store.js';
import type { ChatPartsSidecar } from '../store/chat-parts-store.js';
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import type {
  AcpPlanEntry,
  AcpModelInfo,
  AcpSessionConfigOption,
  AcpSessionMode,
  AcpSessionUpdate,
} from '@sediment/shared';
import type {
  AgentChatContext,
  AgentStreamEvent,
  AvailableCommand,
  ExternalAgentPrompt,
} from '@sediment/shared';
import type { FastifyBaseLogger } from 'fastify';

/** ACP stop reasons we know about; mapped onto pi-ai `stopReason`. */
function mapStopReason(
  reason: string | undefined,
  aborted: boolean,
): AssistantMessage['stopReason'] {
  if (aborted || reason === 'cancelled') return 'aborted';
  if (reason === 'max_tokens') return 'length';
  // Default to 'stop' for end_turn, max_turn_requests, refusal, anything else.
  return 'stop';
}

/** Extract the plain-text payload Sediment will hand to `session/prompt`. */
function extractText(
  content: string | ReadonlyArray<{ type: string; text?: string }> | unknown,
): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (b): b is { type: 'text'; text: string } =>
          !!b &&
          typeof b === 'object' &&
          (b as { type?: unknown }).type === 'text' &&
          typeof (b as { text?: unknown }).text === 'string',
      )
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

export interface RunAcpAgentOptions {
  /**
   * External binding for the active thread. `profileId` references a
   * user-configured spawn recipe (see `./profile-store.ts`); the
   * orchestrator resolves it to a live agentlet agent (spawning one
   * on the daemon if needed). `alias` is purely a label for logs +
   * `prepared_prompt` events.
   */
  binding: { alias: string; profileId: string };
  /** Plain-text or content-block message to send (we extract text below). */
  message: string | ReadonlyArray<{ type: string; text?: string }>;
  /** Sediment thread id \u2014 used as the registry key. */
  threadId: string;
  /**
   * Sediment canvasId for the active thread — plumbed into the
   * AcpAgentClient so capability handlers (fs sandbox, permission gate)
   * can scope checks to the correct canvas. Stored on the session entry
   * too: if a thread’s canvas changes (rebind), the stale session is
   * discarded just like an agent rebind.
   *
   * Optional only because the upstream schema (`agentRequestSchema`)
   * marks `canvasId` optional; in practice an external binding always
   * implies a canvas. The fs sandbox (once implemented) will reject
   * any fs/* request from a session opened without a canvasId.
   */
  canvasId?: string;
  /** pi-ai context; we mutate `context.messages` to append the assistant reply. */
  context: Context;
  /**
   * `cwd` passed to `session/new` on first prompt for this thread.
   * Ignored for subsequent prompts (the session is already open).
   *
   * When omitted, `ensureAcpSession` resolves it from the bound
   * profile's `cwd` (set by the user in Settings → External Agents).
   * If the profile has been deleted and no `bindingRecipe` snapshot
   * was persisted, the call throws — we never silently fall back to
   * a sentinel like `'/'` (which the old agentlet relay was meant to
   * substitute with `process.cwd()` but never did, leaving agents
   * stranded at the filesystem root).
   */
  cwd?: string;
  /**
   * Optional canvas context (selected nodes, etc.) used by the
   * preprocessor to build a focused prompt for the external agent.
   * When omitted, the preprocessor still runs but with no
   * canvas-aware fileRefs hints.
   */
  canvasContext?: AgentChatContext;
  /** Cancellation signal \u2014 wired through to `session/cancel`. */
  signal?: AbortSignal;
  logger: FastifyBaseLogger;
}

// ─── Session lifecycle helper ─────────────────────────────────────────────

export interface EnsureAcpSessionOptions {
  threadId: string;
  /** External binding for the thread (see {@link RunAcpAgentOptions.binding}). */
  binding: { alias: string; profileId: string };
  /**
   * Sediment canvasId scoping the sandbox. Empty string = no canvas
   * (fs/* will be rejected). Mirrors {@link RunAcpAgentOptions.canvasId}.
   */
  canvasId?: string;
  /**
   * `cwd` for `session/new`. When omitted, resolved from the bound
   * profile's `cwd` (see {@link RunAcpAgentOptions.cwd} for the full
   * fallback chain).
   */
  cwd?: string;
  logger: FastifyBaseLogger;
}

/**
 * Per-key map of in-flight `ensureAcpSession` work, used to coalesce
 * concurrent callers so we never run `initialize() + session/new`
 * twice for the same `{threadId, profileId, canvasId}` triple.
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
 * Keying by all three staleness inputs means: different profile / canvas
 * / thread → independent slots, so a binding switch is never blocked
 * waiting on a stale promise.
 */
const inflightEnsureSessions = new Map<string, Promise<AcpSessionEntry>>();

function ensureSessionKey(
  threadId: string,
  profileId: string,
  canvasId: string,
): string {
  return `${threadId}|${profileId}|${canvasId}`;
}

/**
 * Per-`(canvasId, threadId)` debounce slots for meta persistence. Meta
 * updates can arrive in bursts (e.g. an `available_commands_update`
 * immediately followed by a `config_option_update` on session warm-up,
 * or a flurry of `usage_update`s during a long turn), and persisting
 * each one independently would hit the JSON store dozens of times per
 * second on a busy thread. We collapse them into a single tail-write
 * by deferring the flush by {@link META_PERSIST_DEBOUNCE_MS}.
 *
 * Cancellation: callers MUST invoke `cancelPersistEntryMeta` whenever
 * the record is being deleted (binding switch, canvas switch, load
 * failure) — otherwise a queued timer could re-create the file
 * milliseconds after a deliberate `deleteAcpSessionRecord` call.
 */
const META_PERSIST_DEBOUNCE_MS = 250;
const pendingMetaPersists = new Map<string, NodeJS.Timeout>();

function metaPersistKey(canvasId: string, threadId: string): string {
  return `${canvasId}|${threadId}`;
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
  logger: FastifyBaseLogger,
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
  // the same profile resolve `/cached-meta` without re-spawning.
  mirrorEntryToProfileCache(entry);
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
 * No-op when the entry has no `canvasId` (anonymous-canvas threads
 * are not persisted at all — see `writeAcpSessionRecord`).
 */
function schedulePersistEntryMeta(
  entry: AcpSessionEntry,
  logger: FastifyBaseLogger,
): void {
  if (!entry.canvasId) return;
  const threadId = findThreadIdForEntry(entry);
  if (!threadId) return;
  const key = metaPersistKey(entry.canvasId, threadId);
  const prior = pendingMetaPersists.get(key);
  if (prior) clearTimeout(prior);
  const timer = setTimeout(() => {
    pendingMetaPersists.delete(key);
    try {
      writeAcpSessionMeta(entry.canvasId, threadId, snapshotEntryMeta(entry));
    } catch (err) {
      logger.warn(
        {
          threadId,
          canvasId: entry.canvasId,
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

function cancelPersistEntryMeta(canvasId: string, threadId: string): void {
  if (!canvasId) return;
  const key = metaPersistKey(canvasId, threadId);
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
 * no `canvasId` (anonymous-canvas threads aren't persisted at all),
 * or when the reverse lookup fails (entry already removed).
 *
 * Failures are logged and swallowed: missing the promotion just
 * means the user has to re-open the thread on the next server
 * restart, which is the pre-fix behaviour anyway.
 */
function promoteEntryToPersisted(
  entry: AcpSessionEntry,
  logger: FastifyBaseLogger,
): void {
  if (entry.persistedToDisk) return;
  if (!entry.canvasId) return;
  const threadId = findThreadIdForEntry(entry);
  if (!threadId) return;
  try {
    writeAcpSessionRecord(entry.canvasId, threadId, {
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
        canvasId: entry.canvasId,
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
 * persistence layer is keyed by `(canvasId, threadId)`.
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
 * a given `{threadId, profileId, canvasId}` triple — repeated calls
 * return the same {@link AcpSessionEntry} without re-issuing `session/new`.
 *
 * Concurrency: thread-safe across overlapping awaits. Multiple calls
 * for the same `{threadId, profileId, canvasId}` key share the
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
    opts.canvasId ?? '',
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
  const canvasId = opts.canvasId ?? '';
  const persisted = readAcpSessionRecord(canvasId, threadId);

  // Recipe-first resolution:
  //   1. Trust the persisted `bindingRecipe` snapshot (returning thread —
  //      profile mutations / deletions after thread creation must NOT
  //      reach the running agent).
  //   2. Fall back to the live profile lookup (first-time thread, or
  //      legacy v2 record without a recipe). We then snapshot the
  //      profile onto the record below so subsequent calls hit (1).
  //   3. If neither is available, the binding is unbound — fail with a
  //      clear, user-actionable error.
  let recipe: AcpBindingRecipe | null = persisted?.bindingRecipe ?? null;
  if (!recipe) {
    const profile = getProfile(binding.profileId);
    if (profile) {
      recipe = {
        command: profile.command,
        cwd: profile.cwd,
        autoRestart: profile.autoRestart,
        alias: profile.displayName,
        ...(profile.agentTeam && { agentTeam: profile.agentTeam }),
      };
    }
  }
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
    canvasId,
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
  if (entry && entry.canvasId !== canvasId) {
    logger.info(
      {
        threadId,
        oldCanvasId: entry.canvasId,
        newCanvasId: canvasId,
      },
      '[acp] thread canvas changed \u2014 discarding stale session (sandbox scope mismatch)',
    );
    cancelPersistEntryMeta(entry.canvasId, threadId);
    acpSessionRegistry.remove(threadId);
    // Persisted record is canvas-scoped (see session-store path layout),
    // so the wrong-canvas case is already handled implicitly. We still
    // proactively drop the OLD canvas's record to keep the store tidy.
    deleteAcpSessionRecord(entry.canvasId, threadId);
    entry = undefined;
  }
  if (entry && entry.client.isClosed) {
    logger.info(
      { threadId },
      '[acp] stored session client was closed \u2014 reopening',
    );
    cancelPersistEntryMeta(entry.canvasId, threadId);
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

  const client = new AcpAgentClient(conn, { canvasId, logger });

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
    canvasId,
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
    const profileCache = getProfileSchemaCache(binding.profileId);
    if (
      profileCache?.availableCommands &&
      profileCache.availableCommands.length > 0
    ) {
      created.availableCommands = profileCache.availableCommands;
      created.commandsUpdatedAt = profileCache.commandsUpdatedAt ?? 0;
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
      writeAcpSessionRecord(canvasId, threadId, {
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
          canvasId,
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
  logger: FastifyBaseLogger,
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
  logger: FastifyBaseLogger,
): void {
  switch (update.sessionUpdate) {
    case 'available_commands_update':
      applyAvailableCommandsUpdate(entry, update, logger);
      mirrorEntryToProfileCache(entry);
      return;
    case 'config_option_update':
      applyConfigOptionUpdate(entry, update, logger);
      mirrorEntryToProfileCache(entry);
      return;
    case 'current_mode_update':
      applyCurrentModeUpdate(entry, update, logger);
      mirrorEntryToProfileCache(entry);
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

/**
 * Mirror the entry's schema + last-known state into the per-profile
 * cache. Called after any meta update that changes a field shared
 * across all threads of the profile (mode catalogue, model catalogue,
 * config options, slash commands). NOT called for per-session pushes
 * (`session_info_update`, `usage_update`).
 *
 * `availableCommands` is mirrored on an optimistic basis — the agent's
 * SSE `available_commands_update` replaces the cached list wholesale
 * on the next session, so any per-session drift self-corrects.
 *
 * The cache is what `/cached-meta` falls back to when a brand-new
 * thread has no per-thread disk record — see `threads.route.ts`.
 */
function mirrorEntryToProfileCache(entry: AcpSessionEntry): void {
  if (!entry.profileId) return;
  mergeProfileSchemaCache(entry.profileId, {
    availableModes: entry.availableModes,
    currentModeId: entry.currentModeId,
    availableModels: entry.availableModels,
    currentModelId: entry.currentModelId,
    configOptions: entry.configOptions,
    availableCommands: entry.availableCommands,
    commandsUpdatedAt: entry.commandsUpdatedAt,
    metaUpdatedAt: entry.metaUpdatedAt,
  });
}

function applyAvailableCommandsUpdate(
  entry: AcpSessionEntry,
  update: AcpSessionUpdate,
  logger: FastifyBaseLogger,
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
  logger: FastifyBaseLogger,
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
  logger: FastifyBaseLogger,
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
  logger: FastifyBaseLogger,
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
  logger: FastifyBaseLogger,
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

/**
 * Drive a prompt against the bound external agent and yield SSE-shaped
 * events. The route handler is responsible for the surrounding `meta` /
 * `end` frames and for context persistence beyond what we append here.
 */
export async function* runAcpAgent(
  opts: RunAcpAgentOptions,
): AsyncGenerator<AgentStreamEvent> {
  const { binding, threadId, context, canvasContext, signal, logger } = opts;
  const canvasId = opts.canvasId ?? '';
  const rawText = extractText(opts.message);

  // 1-2. Ensure (open or reuse) the per-thread ACP session. The helper
  //      handles connection lookup, stale-entry eviction, initialize +
  //      session/new, and registers the `available_commands_update`
  //      listener so slash-command pushes outside a turn don't get
  //      silently dropped. We deliberately do NOT pass `cwd` here so
  //      `ensureAcpSession` derives it from the bound profile; passing
  //      `'/'` would override the user's configured working directory.
  const entry = await ensureAcpSession({
    threadId,
    binding,
    canvasId,
    ...(opts.cwd !== undefined && { cwd: opts.cwd }),
    logger,
  });

  // 3. Preprocess the user message into a structured ExternalAgentPrompt
  //    BEFORE opening the queue, so the UI sees `prepared_prompt` strictly
  //    before any `text_delta`. On failure we fall back to the raw text
  //    and emit a `prepared_prompt` event with `prompt: null + error` so
  //    the UI can surface the failure (and we still serve the user).
  let preparedPrompt: ExternalAgentPrompt | null = null;
  let preparedError: string | undefined;
  let promptPayload = rawText;
  // Whether this turn's payload actually carried the one-shot system
  // preamble. Drives the post-success flip of `entry.systemPreambleSent`
  // below — so a failed turn (or a slash-command short-circuit, which
  // never includes it) re-sends the preamble on the next real turn.
  let includedSystem = false;
  try {
    const result = prepareExternalAgentPrompt({
      rawText,
      agentAlias: binding.alias,
      canvasContext,
      includeSystem: !entry.systemPreambleSent,
      logger,
    });
    preparedPrompt = result.prompt;
    promptPayload = result.serialized;
    includedSystem = result.includedSystem;
  } catch (err) {
    preparedError = err instanceof Error ? err.message : String(err);
    logger.warn(
      { threadId, agentAlias: binding.alias, err: preparedError },
      '[acp] preprocessor failed — falling back to raw user text',
    );
    promptPayload = serializeRawPrompt(rawText);
  }

  // Persist a sidecar marker on the user's history slot so chat
  // history can rehydrate the PreparedPromptCard. Mirrors the
  // `[SYSTEM Error]` / `[SYSTEM Interrupted]` pattern used elsewhere.
  context.messages.push({
    role: 'user',
    content: `[SYSTEM PreparedPrompt] ${JSON.stringify({
      agentAlias: binding.alias,
      prompt: preparedPrompt,
      error: preparedError,
    })}`,
    timestamp: Date.now(),
  });

  yield {
    type: 'prepared_prompt',
    data: {
      agentAlias: binding.alias,
      prompt: preparedPrompt,
      error: preparedError,
    },
  };

  // 4. Bridge the per-update callback into an async iterable via a queue.
  const queue: AgentStreamEvent[] = [];
  let resolveWaiter: (() => void) | null = null;
  let assembledText = '';
  let promptError: unknown = null;
  let stopReason: string | undefined;
  let done = false;

  // 4a. Turn bookkeeping.
  //
  //   `contentBlocks` accumulates text / thinking / tool-call blocks
  //   in WIRE ORDER. Text and thinking deltas coalesce into the
  //   trailing same-kind block; tool calls push a fresh block. This
  //   list is what we hand to `fauxAssistantMessage` in the `finally`
  //   below, so the persisted message mirrors what the user saw live
  //   (refresh preserves interleaving + thinking blocks + tool-call
  //   order, and gives the sidecar's `toolExtras` content-block ids
  //   to join against).
  //
  //   `sidecar` holds ACP-specific enrichment (toolKind / status /
  //   plan entries / …) that doesn't fit pi-ai's content shape;
  //   keyed by stable ids — `toolExtras[toolCallId]` and
  //   `planByMessageTimestamp[String(timestamp)]`. The assistant
  //   timestamp is only known after the `finally` push, so plan
  //   entries are staged in `pendingPlan` and committed there; a
  //   turn aborted before any output drops the staged plan.
  //
  //   `assistantIndex` lets `recordMessageTimestamp` keep the
  //   sidecar's `messageTimestamps` array index-aligned with
  //   `Context.messages`.
  type AssistantContentBlock =
    | { type: 'text'; text: string }
    | { type: 'thinking'; thinking: string }
    | {
        type: 'toolCall';
        id: string;
        name: string;
        arguments: Record<string, unknown>;
      };
  const contentBlocks: AssistantContentBlock[] = [];
  // Per-toolCallId reference into `contentBlocks` so a later
  // `tool_call_update` can refine the title in place.
  const toolCallByCallId = new Map<
    string,
    Extract<AssistantContentBlock, { type: 'toolCall' }>
  >();
  let sidecar: ChatPartsSidecar =
    readChatParts(threadId, canvasId) ?? emptySidecar();
  const assistantIndex = context.messages.length;
  let sidecarDirty = false;
  let pendingPlan: AcpPlanEntry[] | null = null;
  const persistSidecar = () => {
    if (!sidecarDirty || !canvasId) return;
    try {
      writeChatParts(threadId, sidecar, canvasId);
      sidecarDirty = false;
    } catch (err) {
      // Sidecar failures must NEVER abort the turn — chat history is
      // still functional from the pi-ai file alone. Log + continue.
      logger.warn(
        {
          threadId,
          canvasId,
          err: err instanceof Error ? err.message : String(err),
        },
        '[acp] failed to write chat-parts sidecar',
      );
    }
  };

  const wake = () => {
    if (resolveWaiter) {
      const fn = resolveWaiter;
      resolveWaiter = null;
      fn();
    }
  };

  logger.info(
    {
      threadId,
      sessionId: entry.sessionId,
      profileId: binding.profileId,
      promptLength: promptPayload.length,
      preprocessed: preparedPrompt !== null,
    },
    '[acp] session/prompt dispatch',
  );

  void entry.client
    .prompt(
      entry.sessionId,
      promptPayload,
      (update) => {
        const evt = acpUpdateToStreamEvent(update, logger);
        if (!evt) {
          // TEMP (PR-G debug): info-level so untranslated tool_call /
          // tool_call_update / plan / etc. show up in dev logs and we
          // can see what an external agent is actually doing during a
          // tool-only turn. Lower to `debug` once the translator + UI
          // surface those events as first-class.
          logger.info(
            { sessionUpdate: update.sessionUpdate, raw: update },
            '[acp] untranslated session/update \u2014 dropped',
          );
          return;
        }
        if (evt.type === 'text_delta') {
          assembledText += evt.data.content;
          const last = contentBlocks[contentBlocks.length - 1];
          if (last?.type === 'text') {
            last.text += evt.data.content;
          } else {
            contentBlocks.push({ type: 'text', text: evt.data.content });
          }
        } else if (evt.type === 'thinking_delta') {
          const last = contentBlocks[contentBlocks.length - 1];
          if (last?.type === 'thinking') {
            last.thinking = mergeThinkingChunk(last.thinking, evt.data.content);
          } else {
            contentBlocks.push({
              type: 'thinking',
              thinking: evt.data.content,
            });
          }
        } else if (evt.type === 'tool_call') {
          sidecar = upsertToolExt(sidecar, evt.data.toolCallId, {
            toolKind: evt.data.toolKind,
            status: evt.data.status,
            locations: evt.data.locations,
            content: evt.data.content,
            rawOutput: undefined,
          });
          sidecarDirty = true;
          // `rawInput` may be any JSON shape; pi-ai's `ToolCall.arguments`
          // requires a plain object, so narrow defensively.
          const rawInput = evt.data.rawInput;
          const args: Record<string, unknown> =
            rawInput !== null &&
            typeof rawInput === 'object' &&
            !Array.isArray(rawInput)
              ? (rawInput as Record<string, unknown>)
              : {};
          const block: Extract<AssistantContentBlock, { type: 'toolCall' }> = {
            type: 'toolCall',
            id: evt.data.toolCallId,
            name: evt.data.title || evt.data.toolKind || 'tool',
            arguments: args,
          };
          contentBlocks.push(block);
          toolCallByCallId.set(evt.data.toolCallId, block);
        } else if (evt.type === 'tool_call_update') {
          sidecar = upsertToolExt(sidecar, evt.data.toolCallId, {
            status: evt.data.status,
            locations: evt.data.locations,
            content: evt.data.content,
            rawOutput: evt.data.rawOutput,
          });
          sidecarDirty = true;
          // ACP allows refining the title mid-flight (e.g. "Reading"
          // → "Reading app.ts"); mirror onto the persisted block.
          if (evt.data.title) {
            const tc = toolCallByCallId.get(evt.data.toolCallId);
            if (tc) tc.name = evt.data.title;
          }
        } else if (evt.type === 'plan') {
          // Full-replacement wire semantics: latest plan wins.
          // Staged until the assistant timestamp is known (finally).
          pendingPlan = evt.data.entries;
        }
        queue.push(evt);
        wake();
      },
      signal,
      // Surface agent permission requests as a transient SSE event.
      // The client owns the suspended promise + resolution; we only
      // push the request onto the drain queue. Not persisted to the
      // sidecar — permission prompts are live-only interactions.
      (req) => {
        queue.push({ type: 'permission_request', data: req });
        wake();
      },
    )
    .then((result) => {
      stopReason = result.stopReason;
      // First-prompt promotion: now that the agent has actually
      // processed a user turn, its session is genuinely recoverable
      // (Copilot CLI in particular doesn't persist an empty session
      // across process lifetimes). Lock the sessionId into the disk
      // record so a future server restart can `session/load` it.
      promoteEntryToPersisted(entry, logger);
      // Mark the one-shot system preamble delivered, but only if this
      // turn actually carried it — a failed turn or slash-command
      // short-circuit leaves the flag untouched so the next real turn
      // re-sends it.
      if (includedSystem) entry.systemPreambleSent = true;
    })
    .catch((err: unknown) => {
      promptError = err;
    })
    .finally(() => {
      done = true;
      wake();
    });

  try {
    // 5. Drain the queue as updates arrive.
    while (true) {
      while (queue.length > 0) {
        yield queue.shift()!;
      }
      if (done) break;
      await new Promise<void>((resolve) => {
        resolveWaiter = resolve;
      });
    }

    // 5b. Visibility fallback for "empty" turns.
    //
    // External agents can legitimately finish a turn with zero
    // `agent_message_chunk` text — e.g. Copilot CLI runs a chain of
    // Read/Glob/Bash tool calls and then stops with `end_turn`
    // without emitting prose. The translator only forwards text and
    // thought chunks today, so such turns yield ZERO `text_delta`s
    // and the UI shows nothing for the assistant slot — looks like
    // the server hung.
    //
    // Synthesize a single explanatory `text_delta` whenever the
    // agent produced no text AND we're not about to surface an error
    // or an abort. The synthetic body names the `stopReason` so the
    // user can tell what actually happened, and we treat it as real
    // `assembledText` so it persists in chat history.
    const aborted = signal?.aborted ?? false;
    if (assembledText.length === 0 && !promptError && !aborted) {
      const reason = stopReason ?? 'unknown';
      const synthetic = `_(agent returned no text — stopReason: ${reason}. Usually a tool-only turn or a refusal without prose. Extend the ACP translator if you need tool-call rendering.)_`;
      assembledText = synthetic;
      // Push as a trailing text block so the synthetic also survives
      // refresh alongside any tool calls emitted earlier in the turn.
      contentBlocks.push({ type: 'text', text: synthetic });
      yield { type: 'text_delta', data: { content: synthetic } };
    }
  } finally {
    // 6. Persist assistant output. Mirrors `runAgent`'s `finally` so
    //    partial replies survive abort/error. `contentBlocks` is
    //    already in wire order, so we hand it straight to pi-ai.
    if (contentBlocks.length > 0) {
      const aborted = signal?.aborted ?? false;
      const timestamp = Date.now();
      context.messages.push(
        fauxAssistantMessage(contentBlocks, {
          stopReason: mapStopReason(stopReason, aborted),
          timestamp,
        }),
      );
      // Stamp arrival time AFTER the push so the sidecar's
      // `messageTimestamps` stays index-aligned with `Context.messages`.
      // First-write-wins guards against retry overwrites.
      sidecar = recordMessageTimestamp(sidecar, assistantIndex, timestamp);
      sidecarDirty = true;
      if (pendingPlan) {
        sidecar = setPlanForMessage(sidecar, timestamp, pendingPlan);
        pendingPlan = null;
      }
    }
    // 6b. Persist the rich-ACP sidecar regardless of error/abort —
    //     partial tool calls captured before the failure still
    //     survive a refresh.
    persistSidecar();
  }

  // 7. Yield terminal event \u2014 error wins over done.
  if (promptError) {
    const msg =
      promptError instanceof Error ? promptError.message : String(promptError);
    logger.warn(
      { threadId, sessionId: entry.sessionId, err: msg },
      '[acp] session/prompt failed',
    );
    yield { type: 'error', data: { error: msg } };
    return;
  }

  yield {
    type: 'done',
    data: {
      message: assembledText,
      meta: { stopReason },
    },
  };
}
