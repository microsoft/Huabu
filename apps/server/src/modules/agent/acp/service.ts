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

import { AcpAgentClient } from './client.js';
import {
  prepareExternalAgentPrompt,
  serializeRawPrompt,
} from './preprocessor.js';
import { getAgentletServer } from './server-mount.js';
import { acpSessionRegistry } from './session-registry.js';
import { acpUpdateToStreamEvent } from './translator.js';
import { canvasRoot as resolveCanvasRoot } from '../../storage/paths.js';
import {
  appendPlanPart,
  emptySidecar,
  readChatParts,
  recordMessageTimestamp,
  upsertToolExt,
  writeChatParts,
} from '../store/chat-parts-store.js';

import type { AcpSessionEntry } from './session-registry.js';
import type { ChatPartsSidecar } from '../store/chat-parts-store.js';
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import type { AcpSessionUpdate } from '@sediment/shared';
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

  logger.info(
    { threadId, canvasId, agentId: binding.agentletAgentId, cwd },
    '[acp] opening new session for thread',
  );
  const client = new AcpAgentClient(conn, { canvasId, logger });
  await client.initialize();
  const sessionId = await client.newSession({ cwd });
  const created: AcpSessionEntry = {
    client,
    sessionId,
    agentletAgentId: binding.agentletAgentId,
    canvasId,
    cwd,
    createdAt: Date.now(),
    availableCommands: [],
    commandsUpdatedAt: 0,
  };
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
  acpSessionRegistry.set(threadId, created);
  return created;
}

/**
 * Long-lived session listener — handles out-of-turn `session/update`
 * notifications carrying session-scoped metadata. Currently only
 * `available_commands_update`; new metadata variants plug in here.
 */
function handleSessionMetaUpdate(
  entry: AcpSessionEntry,
  update: AcpSessionUpdate,
  logger: FastifyBaseLogger,
): void {
  if (update.sessionUpdate !== 'available_commands_update') return;
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

  // 4a. Sidecar bookkeeping. Tool-call and plan events emitted during
  //     the turn carry ACP-specific enrichment that doesn't fit in
  //     pi-ai's `AssistantMessage.content` shape, so we mirror them
  //     into `<threadId>.parts.json` for later history reconstruction.
  //     `assistantIndex` is the position the future assistant message
  //     will occupy (`context.messages.length` at this point already
  //     includes the user push above). Computed once and reused for
  //     every event in the turn so all sidecar parts share the same
  //     message anchor.
  let sidecar: ChatPartsSidecar =
    readChatParts(threadId, canvasId) ?? emptySidecar();
  const assistantIndex = context.messages.length;
  let sidecarDirty = false;
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
        if (evt.type === 'text_delta') assembledText += evt.data.content;
        // Mirror rich-ACP events into the sidecar overlay. Failures
        // (e.g. RangeError on malformed entries) are swallowed via
        // the writer's try/catch in `persistSidecar` later; here we
        // only stage the in-memory mutation.
        if (evt.type === 'tool_call') {
          sidecar = upsertToolExt(
            sidecar,
            evt.data.toolCallId,
            {
              toolKind: evt.data.toolKind,
              status: evt.data.status,
              locations: evt.data.locations,
              content: evt.data.content,
              rawOutput: undefined,
            },
            { messageIndex: assistantIndex },
          );
          sidecarDirty = true;
        } else if (evt.type === 'tool_call_update') {
          sidecar = upsertToolExt(
            sidecar,
            evt.data.toolCallId,
            {
              status: evt.data.status,
              // `title` is on the wire but lives on the ACP envelope,
              // not the persistence extension — skip it here, the
              // value is already in the SSE event for live UI.
              locations: evt.data.locations,
              content: evt.data.content,
              rawOutput: evt.data.rawOutput,
            },
            { messageIndex: assistantIndex },
          );
          sidecarDirty = true;
        } else if (evt.type === 'plan') {
          sidecar = appendPlanPart(sidecar, assistantIndex, evt.data.entries);
          sidecarDirty = true;
        }
        queue.push(evt);
        wake();
      },
      signal,
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
      yield { type: 'text_delta', data: { content: synthetic } };
    }
  } finally {
    // 6. Always sync the assistant’s text back into context.messages,
    //    even on abort/error \u2014 mirrors `runAgent`\u2019s `finally` sync
    //    so partial replies survive page reloads. Captures any
    //    synthetic fallback emitted above too.
    if (assembledText.length > 0) {
      const aborted = signal?.aborted ?? false;
      const timestamp = Date.now();
      context.messages.push(
        fauxAssistantMessage(assembledText, {
          stopReason: mapStopReason(stopReason, aborted),
          timestamp,
        }),
      );
      // Stamp the sidecar with the assistant arrival time only AFTER
      // the pi-ai push completes — keeps the two files index-aligned.
      // `recordMessageTimestamp` is first-write-wins, so a retry of
      // the same turn never overwrites the original arrival time.
      sidecar = recordMessageTimestamp(sidecar, assistantIndex, timestamp);
      sidecarDirty = true;
    }
    // 6b. Persist the rich-ACP sidecar regardless of error/abort —
    //     partial tool calls captured before the failure still
    //     survive a refresh once the read path is wired.
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
