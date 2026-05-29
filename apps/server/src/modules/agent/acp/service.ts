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

import { AcpAgentClient, agentSupportsLoadSession } from './client.js';
import {
  prepareExternalAgentPrompt,
  serializeRawPrompt,
} from './preprocessor.js';
import { getAgentletServer } from './server-mount.js';
import { acpSessionRegistry } from './session-registry.js';
import {
  deleteAcpSessionRecord,
  readAcpSessionRecord,
  writeAcpSessionRecord,
} from './session-store.js';
import { acpUpdateToStreamEvent, mergeThinkingChunk } from './translator.js';
import { canvasRoot as resolveCanvasRoot } from '../../storage/paths.js';
import {
  emptySidecar,
  readChatParts,
  recordMessageTimestamp,
  setPlanForMessage,
  upsertToolExt,
  writeChatParts,
} from '../store/chat-parts-store.js';

import type { AcpSessionEntry } from './session-registry.js';
import type { ChatPartsSidecar } from '../store/chat-parts-store.js';
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import type {
  AcpModelInfo,
  AcpPlanEntry,
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
  /** External binding for the active thread. */
  binding: { alias: string; agentletAgentId: string };
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
   * Defaults to `'/'`, which is the **agreed sentinel** with the
   * agentlet relay: when `params.cwd` is missing or `'/'`, the relay
   * substitutes its own `process.cwd()` (see
   * `agentlet/packages/local/src/relay.ts#enrichMessage`). This keeps
   * the local working directory authoritative on the user's machine
   * and frees Sediment from guessing repo paths until canvas ↔ repo
   * binding is wired here.
   *
   * **Current user contract**: launch agentlet from the project root
   * (`cd <repo> && agentlet --agent "claude --acp" --server …`).
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
  /** External binding for the thread. */
  binding: { alias: string; agentletAgentId: string };
  /**
   * Sediment canvasId scoping the sandbox. Empty string = no canvas
   * (fs/* will be rejected). Mirrors {@link RunAcpAgentOptions.canvasId}.
   */
  canvasId?: string;
  /** `cwd` for `session/new`. Defaults to `'/'` (relay substitutes its cwd). */
  cwd?: string;
  logger: FastifyBaseLogger;
}

/**
 * Per-key map of in-flight `ensureAcpSession` work, used to coalesce
 * concurrent callers so we never run `initialize() + session/new`
 * twice for the same `{threadId, agentletAgentId, canvasId}` triple.
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
 * Keying by all three staleness inputs means: different agent / canvas
 * / thread → independent slots, so a binding switch is never blocked
 * waiting on a stale promise.
 */
const inflightEnsureSessions = new Map<string, Promise<AcpSessionEntry>>();

function ensureSessionKey(
  threadId: string,
  agentletAgentId: string,
  canvasId: string,
): string {
  return `${threadId}|${agentletAgentId}|${canvasId}`;
}

/**
 * Get-or-create the per-thread ACP session, installing the long-lived
 * `available_commands_update` listener on first creation. Idempotent for
 * a given `{threadId, agentletAgentId, canvasId}` triple — repeated calls
 * return the same {@link AcpSessionEntry} without re-issuing `session/new`.
 *
 * Concurrency: thread-safe across overlapping awaits. Multiple calls
 * for the same `{threadId, agentletAgentId, canvasId}` key share the
 * same in-flight promise so only one `initialize() + session/new`
 * pair is ever issued for a given coalescing window.
 *
 * Stale-entry rules (mirror the logic previously inlined in
 * `runAcpAgent`):
 *  - Binding switched to a different agent → drop and rebuild.
 *  - Canvas changed → drop (sandbox scope mismatch).
 *  - Stored client was shut down → drop and reopen.
 *
 * Throws synchronously when the agentlet bridge is not mounted or the
 * agent is not connected — same surface as the inline path so callers
 * can `try`/`catch` uniformly.
 */
export async function ensureAcpSession(
  opts: EnsureAcpSessionOptions,
): Promise<AcpSessionEntry> {
  const key = ensureSessionKey(
    opts.threadId,
    opts.binding.agentletAgentId,
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
  const cwd = opts.cwd ?? '/';

  const server = getAgentletServer();
  if (!server) {
    throw new Error(
      'ACP server not mounted \u2014 set ENABLE_ACP=1 and restart',
    );
  }
  const conn = server.getConnection(binding.agentletAgentId);
  if (!conn || conn.status !== 'connected') {
    throw new Error(
      `External agent '${binding.alias}' (id=${binding.agentletAgentId}) is not connected`,
    );
  }

  let entry = acpSessionRegistry.get(threadId);
  if (entry && entry.agentletAgentId !== binding.agentletAgentId) {
    logger.info(
      {
        threadId,
        oldAgentId: entry.agentletAgentId,
        newAgentId: binding.agentletAgentId,
      },
      '[acp] thread binding changed \u2014 discarding stale session',
    );
    acpSessionRegistry.remove(threadId);
    // Stale binding → persisted sessionId is also stale (it belongs to
    // the OLD agent). Drop it so we don't try to load it against the
    // new agent on the next miss.
    deleteAcpSessionRecord(canvasId, threadId);
    entry = undefined;
  }
  if (entry && entry.canvasId !== canvasId) {
    logger.info(
      {
        threadId,
        oldCanvasId: entry.canvasId,
        newCanvasId: canvasId,
      },
      '[acp] thread canvas changed \u2014 discarding stale session (sandbox scope mismatch)',
    );
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

  // No live session for this thread in the registry. Open the SDK
  // client + run `initialize` first, then try to recover a persisted
  // sessionId via `session/load`; fall back to `session/new` when
  // there is no record, the agent does not support load, or the load
  // call rejects (e.g. agent restarted and forgot the session).
  const persisted = readAcpSessionRecord(canvasId, threadId);
  const client = new AcpAgentClient(conn, { canvasId, logger });
  await client.initialize();

  // Build the entry skeleton up front so the long-lived
  // `available_commands_update` listener can be installed BEFORE
  // `session/load`. The listener mutates `created.availableCommands`
  // in place (see {@link handleSessionMetaUpdate}); the sessionId
  // field is filled in below once known. This matters because
  // `session/load` typically replays the full session history as a
  // stream of `session/update` notifications — far more than the
  // orphan-buffer cap of `MAX_ORPHAN_UPDATES_PER_SESSION = 32` would
  // tolerate. With a listener attached, dispatched updates skip the
  // orphan buffer entirely.
  const created: AcpSessionEntry = {
    client,
    sessionId: '',
    agentletAgentId: binding.agentletAgentId,
    canvasId,
    cwd,
    createdAt: Date.now(),
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

  let sessionId: string | null = null;
  let removeListener: (() => void) | null = null;

  if (persisted && persisted.agentletAgentId === binding.agentletAgentId) {
    if (agentSupportsLoadSession(client.initializeResult)) {
      logger.info(
        {
          threadId,
          canvasId,
          agentId: binding.agentletAgentId,
          sessionId: persisted.sessionId,
          cwd: persisted.cwd,
        },
        '[acp] attempting session/load for persisted session',
      );
      // Listener installed BEFORE the load so replay notifications go
      // straight to handleSessionMetaUpdate (and through it to no-op
      // for non-meta updates) instead of overflowing the orphan buffer.
      removeListener = client.registerSessionListener(
        persisted.sessionId,
        (update) => handleSessionMetaUpdate(created, update, logger),
      );
      try {
        const loadResult = await client.loadSession({
          sessionId: persisted.sessionId,
          cwd: persisted.cwd,
        });
        sessionId = persisted.sessionId;
        created.sessionId = sessionId;
        seedSessionMetaFromResponse(created, loadResult, logger);
        logger.info(
          { threadId, sessionId },
          '[acp] session/load succeeded \u2014 resumed external agent memory',
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        // "Already loaded" is the BEST possible outcome: the agent
        // process is still alive (typical scenario: only the Sediment
        // server restarted, the user's agentlet CLI kept running) and
        // already holds the session in memory. Adopt it as-is — no
        // replay needed, no fallback. Copilot CLI surfaces this as
        // `Session <id> is already loaded`; other agents may use
        // different wording, hence the permissive substring check.
        if (/already\s*loaded/i.test(errMsg)) {
          sessionId = persisted.sessionId;
          created.sessionId = sessionId;
          logger.info(
            { threadId, sessionId },
            '[acp] session already loaded in live agent \u2014 reusing without replay',
          );
        } else {
          // Real failure (agent forgot the session, wrong sessionId,
          // capability lied, transport error, ...). Drop the listener
          // + stale record and fall through to newSession; the user
          // pays one extra round-trip but the thread keeps working.
          removeListener();
          removeListener = null;
          logger.warn(
            {
              threadId,
              sessionId: persisted.sessionId,
              err: errMsg,
            },
            '[acp] session/load failed \u2014 dropping persisted record and falling back to session/new',
          );
          deleteAcpSessionRecord(canvasId, threadId);
        }
      }
    } else {
      logger.info(
        { threadId, agentId: binding.agentletAgentId },
        '[acp] agent does not advertise loadSession capability \u2014 cannot resume; using session/new',
      );
      // Don't delete the record here: a future agent upgrade may add
      // loadSession support, and the existing sessionId might still be
      // valid in the agent. Keeping it costs nothing.
    }
  }

  if (!sessionId) {
    logger.info(
      { threadId, canvasId, agentId: binding.agentletAgentId, cwd },
      '[acp] opening new session for thread',
    );
    const newResult = await client.newSession({ cwd });
    sessionId = newResult.sessionId;
    created.sessionId = sessionId;
    seedSessionMetaFromResponse(created, newResult, logger);
  }

  if (!removeListener) {
    // Install the long-lived listener BEFORE adding the entry to the
    // registry so subsequent registry lookups always see an entry with
    // a wired-up listener. The listener registration itself replays
    // any orphan `available_commands_update` notifications that
    // arrived BEFORE `session/new` resolved (a common ACP wire
    // ordering — see `AcpAgentClient.orphanUpdates`), so we never
    // miss the agent's initial command-list push regardless of who
    // wins the response-vs-notification race.
    client.registerSessionListener(sessionId, (update) => {
      handleSessionMetaUpdate(created, update, logger);
    });
  }
  acpSessionRegistry.set(threadId, created);

  // Persist (or refresh) the record so a future server restart can
  // recover this session. Done AFTER the registry insert so the
  // happy-path memory state is authoritative; persistence failures
  // (logged below) only forfeit recovery, not the current session.
  try {
    writeAcpSessionRecord(canvasId, threadId, {
      sessionId,
      agentletAgentId: binding.agentletAgentId,
      cwd,
    });
  } catch (err) {
    logger.warn(
      {
        threadId,
        canvasId,
        err: err instanceof Error ? err.message : String(err),
      },
      '[acp] failed to persist session record (recovery after restart will fall back to session/new)',
    );
  }

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
  logger: FastifyBaseLogger,
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
  logger.info(
    { sessionId: entry.sessionId, used, size },
    '[acp] usage_update applied',
  );
}

/**
 * Seed the session entry from the `modes` / `models` / `configOptions`
 * fields of a `session/new` or `session/load` response, when present.
 * Permissive — silently skips fields the agent didn't include.
 */
function seedSessionMetaFromResponse(
  entry: AcpSessionEntry,
  response: { modes?: unknown; models?: unknown; configOptions?: unknown },
  logger: FastifyBaseLogger,
): void {
  let touched = false;
  if (response.modes && typeof response.modes === 'object') {
    const m = response.modes as {
      availableModes?: unknown;
      currentModeId?: unknown;
    };
    if (Array.isArray(m.availableModes)) {
      entry.availableModes = m.availableModes as AcpSessionMode[];
      touched = true;
    }
    if (typeof m.currentModeId === 'string' && m.currentModeId) {
      entry.currentModeId = m.currentModeId;
      touched = true;
    }
  }
  if (response.models && typeof response.models === 'object') {
    const m = response.models as {
      availableModels?: unknown;
      currentModelId?: unknown;
    };
    if (Array.isArray(m.availableModels)) {
      entry.availableModels = m.availableModels as AcpModelInfo[];
      touched = true;
    }
    if (typeof m.currentModelId === 'string' && m.currentModelId) {
      entry.currentModelId = m.currentModelId;
      touched = true;
    }
  }
  if (Array.isArray(response.configOptions)) {
    entry.configOptions = response.configOptions as AcpSessionConfigOption[];
    touched = true;
  }
  if (touched) {
    entry.metaUpdatedAt = Date.now();
    logger.info(
      {
        sessionId: entry.sessionId,
        modeCount: entry.availableModes.length,
        modelCount: entry.availableModels.length,
        configCount: entry.configOptions.length,
      },
      '[acp] seeded session-meta from session/new|load response',
    );
  }
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
  // ── Workspace model for the bound external agent ───────────────────
  //
  // ACP separates two notions that we deliberately keep distinct here:
  //
  //   1. Protocol workspace (what `acp/capabilities/fs.ts` exposes)
  //        = the virtual `/canvas/` namespace, read-only, allowlisted
  //          to `nodes/**` + `.artifacts/**`, scoped to this canvasId.
  //        Reachable only via ACP `fs/read_text_file`.
  //
  //   2. Agent execution workspace (the agent process' own `cwd`)
  //        = whatever the agentlet relay substitutes for the `'/'`
  //          sentinel below, i.e. the relay's `process.cwd()`. By
  //          contract the user launches agentlet from their project
  //          root, so the agent's native shell/fs sees the repo,
  //          not the canvas dir.
  //
  // Empirically (see /tmp/copilot-acp-probe.mjs) not every agent
  // honours (1): Copilot CLI's `Read` tool **never** calls
  // `fs/read_text_file` — it always issues an OS syscall, asking
  // `session/request_permission` only when the path falls outside
  // its own trusted-dirs list. To keep Copilot useful for canvas
  // work, the preprocessor renders `fileRefs` as **real absolute
  // paths** under `canvasCwd` so Copilot's OS-level Read can open
  // them (after a one-shot permission prompt). Claude Code and other
  // ACP-fs-bridging agents get the same absolute paths and can read
  // them either way.
  //
  // Trade-off: the absolute-path projection effectively re-extends
  // the agent's OS reach into the canvas dir, so the `/canvas/` VFS
  // sandbox in `acp/capabilities/fs.ts` is bypassed for native-fs
  // agents. Real isolation against a hostile agent would require an
  // OS-level boundary (container / FUSE); ACP fs capabilities alone
  // are cooperative.
  //
  // For the (currently unused) edge case of a thread with no canvasId
  // we omit `canvasCwd`; the preprocessor then falls back to
  // `/canvas/<rel>` virtual paths so any spec-compliant agent can
  // still reach files via the ACP fs handler.
  const canvasCwd = canvasId ? resolveCanvasRoot(canvasId) : undefined;
  const cwd = opts.cwd ?? '/';

  // 1-2. Ensure (open or reuse) the per-thread ACP session. The helper
  //      handles connection lookup, stale-entry eviction, initialize +
  //      session/new, and registers the `available_commands_update`
  //      listener so slash-command pushes outside a turn don't get
  //      silently dropped.
  const entry = await ensureAcpSession({
    threadId,
    binding,
    canvasId,
    cwd,
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
  try {
    const result = await prepareExternalAgentPrompt({
      rawText,
      agentAlias: binding.alias,
      canvasContext,
      canvasRoot: canvasCwd,
      history: context.messages,
      logger,
    });
    preparedPrompt = result.prompt;
    promptPayload = result.serialized;
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
      agentId: binding.agentletAgentId,
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
