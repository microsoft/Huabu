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

import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import type {
  AgentChatContext,
  AgentStreamEvent,
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

  // 1. Resolve the live agentlet connection.
  const server = getAgentletServer();
  if (!server) {
    throw new Error(
      'ACP server not mounted \u2014 set SEDIMENT_ENABLE_ACP=1 and restart',
    );
  }
  const conn = server.getConnection(binding.agentletAgentId);
  if (!conn || conn.status !== 'connected') {
    throw new Error(
      `External agent '${binding.alias}' (id=${binding.agentletAgentId}) is not connected`,
    );
  }

  // 2. Get or create the per-thread ACP session.
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
  if (!entry) {
    logger.info(
      { threadId, canvasId, agentId: binding.agentletAgentId, cwd },
      '[acp] opening new session for thread',
    );
    const client = new AcpAgentClient(conn, { canvasId, logger });
    await client.initialize();
    const sessionId = await client.newSession({ cwd });
    entry = {
      client,
      sessionId,
      agentletAgentId: binding.agentletAgentId,
      canvasId,
      cwd,
      createdAt: Date.now(),
    };
    acpSessionRegistry.set(threadId, entry);
  } else {
    logger.debug(
      { threadId, sessionId: entry.sessionId },
      '[acp] reusing existing session for thread',
    );
  }

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
        const evt = acpUpdateToStreamEvent(update);
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
      context.messages.push(
        fauxAssistantMessage(assembledText, {
          stopReason: mapStopReason(stopReason, aborted),
          timestamp: Date.now(),
        }),
      );
    }
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
