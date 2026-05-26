/**
 * `runAcpAgent` \u2014 the external-binding counterpart of `runAgent`.
 *
 * Drives a single user prompt against an ACP-connected external agent
 * (Copilot / Claude Code / Codex / \u2026) and yields the resulting stream
 * as Sediment\u2019s standard `AgentStreamEvent`s, so the route handler can
 * treat external and internal dispatches uniformly.
 *
 * Persistence model (PR C, "Plan B"): one ACP session per Sediment
 * thread, kept alive for the thread\u2019s lifetime via {@link
 * acpSessionRegistry}. Successive prompts on the same thread reuse the
 * sessionId so the external agent retains conversation memory.
 *
 * Scope of translation in PR C: text deltas only \u2014
 * `session/update.agent_message_chunk` \u2192 `text_delta`. Tool calls,
 * plans, thinking, and mode updates are silently dropped by the translator
 * and will be added incrementally in later phases.
 */

import { fauxAssistantMessage } from '@earendil-works/pi-ai';

import { AcpAgentClient } from './client.js';
import { getAgentletServer } from './server-mount.js';
import { acpSessionRegistry } from './session-registry.js';
import { acpUpdateToStreamEvent } from './translator.js';

import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import type { AgentStreamEvent } from '@sediment/shared';
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
  /** pi-ai context; we mutate `context.messages` to append the assistant reply. */
  context: Context;
  /**
   * `cwd` passed to `session/new` on first prompt for this thread. Ignored
   * for subsequent prompts (the session is already open). Defaults to
   * `'/'`, which signals the agentlet relay to substitute its own `--cwd`.
   * Phase 4 will pass an explicit canvas-bound repo path here.
   */
  cwd?: string;
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
  const { binding, threadId, context, signal, logger } = opts;
  const text = extractText(opts.message);
  // Default to '/' so the agentlet relay overrides with its own --cwd
  // (relay.ts only substitutes when params.cwd is empty or '/'). Phase 4
  // canvas↔repo binding will pass an explicit opts.cwd here.
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
      { threadId, agentId: binding.agentletAgentId, cwd },
      '[acp] opening new session for thread',
    );
    const client = new AcpAgentClient(conn, { logger });
    await client.initialize();
    const sessionId = await client.newSession({ cwd });
    entry = {
      client,
      sessionId,
      agentletAgentId: binding.agentletAgentId,
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

  // 3. Bridge the per-update callback into an async iterable via a queue.
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
      promptLength: text.length,
    },
    '[acp] session/prompt dispatch',
  );

  void entry.client
    .prompt(
      entry.sessionId,
      text,
      (update) => {
        const evt = acpUpdateToStreamEvent(update);
        if (!evt) {
          logger.debug(
            { sessionUpdate: update.sessionUpdate },
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
    // 4. Drain the queue as updates arrive.
    while (true) {
      while (queue.length > 0) {
        yield queue.shift()!;
      }
      if (done) break;
      await new Promise<void>((resolve) => {
        resolveWaiter = resolve;
      });
    }
  } finally {
    // 5. Always sync the assistant\u2019s text back into context.messages,
    //    even on abort/error \u2014 mirrors `runAgent`\u2019s `finally` sync
    //    so partial replies survive page reloads.
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

  // 6. Yield terminal event \u2014 error wins over done.
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
