// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unified Agent Route
 *
 * Single SSE endpoint that handles all modes: chat, agent.
 * Replaces the separate chat.route.ts with a
 * unified API powered by pi-ai.
 *
 * POST /api/agent          — Start or continue an agent conversation
 * GET  /api/agent/history/:threadId — Load conversation history
 */

import {
  AGENT_SSE_EVENTS,
  agentCanvasIdQuerySchema,
  agentRequestSchema,
  createId,
  forkThreadBodySchema,
  setChatThreadModelRequestSchema,
  setChatThreadReasoningEffortRequestSchema,
} from '@huabu/shared';

import { agenetes } from '../agent/agenetes/drivers.js';
import { INTERNAL_DRIVER_KIND } from '../agent/agenetes/drivers.js';
import {
  AgentThreadBusyError,
  agentThreadService,
} from '../agent/agent-thread.service.js';
import { buildChatEnvelope } from '../agent/conversation/envelope.js';
import { buildHistoryFromTurns } from '../agent/conversation/transcript/history.js';
import { getLLMModel } from '../agent/llm.js';
import { canvasAcpNamespace } from '../workspace/paths.js';

import type { ControlMsg, Namespace } from '@agenetes/protocol';
import type {
  AgentCanvasIdQuery,
  AgentRequest,
  AgentStreamEvent,
  ApiResult,
  ChatHistoryItem,
  ChatHistoryResponse,
  ChatThreadSettingsResponse,
  ContextTokensResponse,
  ForkThreadBody,
  ForkThreadResponse,
  SetChatThreadSettingResponse,
  StopThreadResponse,
} from '@huabu/shared';
import type { FastifyPluginAsync } from 'fastify';

// ==================== Helpers ====================

function getOrCreateThreadId(value: unknown): string {
  if (typeof value === 'string' && value.trim().length > 0) return value;
  return createId('thread');
}

function writeSSE(
  raw: NodeJS.WritableStream,
  event: { type: string; data: unknown },
): void {
  raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
}

// ==================== Route ====================

/**
 * Dispatch a {@link ControlMsg} to a built-in (internal) chat thread's
 * durable handle. Reuses the live Deployment handle when present, otherwise
 * rehydrates from the persisted record so the selection is still applied +
 * persisted. Guards against targeting an ACP thread or a thread that does
 * not exist yet (a brand-new conversation has no record until its first
 * turn; the client holds the pending selection until then).
 */
async function dispatchBuiltinControl(
  namespace: Namespace,
  threadId: string,
  msg: ControlMsg,
): Promise<
  { ok: true } | { ok: false; status: number; message: string; code: string }
> {
  const record = agenetes.record(namespace, threadId);
  if (!record) {
    return {
      ok: false,
      status: 404,
      message: `No built-in thread '${threadId}' to configure yet`,
      code: 'thread_not_found',
    };
  }
  if (record.spec.kind !== INTERNAL_DRIVER_KIND) {
    return {
      ok: false,
      status: 409,
      message: 'Per-thread model settings apply to the built-in agent only',
      code: 'not_builtin',
    };
  }
  const handle = agenetes.get(threadId) ?? agenetes.create(record.spec);
  const ack = await handle.control(msg);
  if (!ack.ok) {
    return {
      ok: false,
      status: 502,
      message: ack.error,
      code: ack.code ?? 'control_failed',
    };
  }
  return { ok: true };
}

/** Read a built-in thread's per-thread selection from its durable record. */
function readBuiltinThreadSettings(
  namespace: Namespace,
  threadId: string,
): ChatThreadSettingsResponse {
  const driverState = (agenetes.record(namespace, threadId)?.state
    ?.driverState ?? {}) as { modelId?: unknown; reasoningEffort?: unknown };
  return {
    modelId:
      typeof driverState.modelId === 'string' ? driverState.modelId : null,
    reasoningEffort:
      typeof driverState.reasoningEffort === 'string'
        ? driverState.reasoningEffort
        : null,
  };
}

const agentRoutes: FastifyPluginAsync = async (
  fastify,
  _opts,
): Promise<void> => {
  /**
   * GET /agent/history/:threadId
   * Reconstructs the UI message list from L2's folded Tier-2 turn log
   * (`agenetes.history`), the single source of truth for conversation
   * history.
   */
  fastify.get<{
    Params: { threadId: string };
    Querystring: AgentCanvasIdQuery;
    Reply: ApiResult<ChatHistoryResponse>;
  }>('/history/:threadId', async function (request, reply) {
    const { threadId } = request.params;
    const parsedQuery = agentCanvasIdQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply.code(400).send({
        message: parsedQuery.error.issues[0]?.message ?? 'Invalid query',
      });
    }
    const { canvasId } = parsedQuery.data;

    if (!threadId || threadId.trim().length === 0) {
      return reply.code(400).send({ message: 'threadId is required' });
    }

    const namespace = canvasAcpNamespace(canvasId ?? '');
    if (agentThreadService.isActive(threadId, canvasId)) {
      await agentThreadService.waitForTurnStart(threadId, canvasId);
    }
    const { turns } = agenetes.history(namespace, threadId, {
      withTail: true,
    });
    if (turns.length === 0) {
      // No folded turns → empty/new thread.
      return reply.send({ threadId, messages: [] });
    }

    const messages: ChatHistoryItem[] = [];
    const record = agenetes.record(namespace, threadId);
    const isInternalThread =
      (record?.spec as { kind?: unknown } | undefined)?.kind === 'internal';
    buildHistoryFromTurns(turns, messages, {
      recoverInternalToolNames: isInternalThread,
    });

    return reply.send({ threadId, messages });
  });

  /**
   * POST /agent/history/:threadId/fork
   *
   * Temporarily unavailable while #321 defines the explicit target-agent
   * contract required to compile a complete target WorkloadSpec.
   */
  fastify.post<{
    Params: { threadId: string };
    Querystring: AgentCanvasIdQuery;
    Body: ForkThreadBody;
    Reply: ApiResult<ForkThreadResponse>;
  }>('/history/:threadId/fork', async function (request, reply) {
    const { threadId } = request.params;
    const parsedQuery = agentCanvasIdQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply.code(400).send({
        message: parsedQuery.error.issues[0]?.message ?? 'Invalid query',
      });
    }
    const parsedBody = forkThreadBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({
        message: parsedBody.error.issues[0]?.message ?? 'Invalid body',
      });
    }

    const { canvasId } = parsedQuery.data;
    const { targetThreadId, targetCanvasId } = parsedBody.data;
    const dstCanvasId = targetCanvasId ?? canvasId;

    if (!threadId || threadId.trim().length === 0) {
      return reply.code(400).send({ message: 'threadId is required' });
    }
    if (!canvasId || !dstCanvasId) {
      return reply.code(400).send({ message: 'canvasId is required' });
    }
    if (targetThreadId === threadId) {
      return reply
        .code(400)
        .send({ message: 'target thread must differ from source' });
    }

    return reply.code(501).send({
      message:
        'Thread fork is temporarily unavailable until the target agent contract is explicit.',
    });
  });

  /**
   * POST /agent/stop/:threadId
   * Explicitly stop an active agent run. Only this endpoint triggers
   * the interrupted state — client disconnects (e.g. page refresh) do not.
   */
  fastify.post<{
    Params: { threadId: string };
    Reply: ApiResult<StopThreadResponse>;
  }>('/stop/:threadId', async function (request, reply) {
    const { threadId } = request.params;
    if (agentThreadService.stop(threadId)) {
      return reply.send({ stopped: true });
    }
    return reply.send({ stopped: false });
  });

  /**
   * GET /agent/stream/:threadId
   * Reconnect to an active agent run. Replays L2's Tier-1 event log from
   * the last folded turn (`agenetes.tail`), then follows live events until
   * the run's terminal (`done` / `error` / `end`) frame or client
   * disconnect. L2 is the single source of truth, so no host-side event
   * buffer is kept.
   */
  fastify.get<{
    Params: { threadId: string };
    Querystring: AgentCanvasIdQuery;
  }>('/stream/:threadId', async function (request, reply) {
    const { threadId } = request.params;
    const parsedQuery = agentCanvasIdQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply.code(400).send({
        message: parsedQuery.error.issues[0]?.message ?? 'Invalid query',
      });
    }
    const { canvasId } = parsedQuery.data;
    if (
      !agentThreadService.isActive(threadId, canvasId) ||
      !(await agentThreadService.waitForTurnStart(threadId, canvasId)) ||
      !agentThreadService.isActive(threadId, canvasId)
    ) {
      return reply.code(404).send({ message: 'No active run' });
    }

    // SSE setup
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.flushHeaders?.();
    reply.raw.write(': ok\n\n');

    // Stop pumping if the client goes away mid-stream.
    let clientGone = false;
    const onClose = () => {
      clientGone = true;
    };
    reply.raw.once('close', onClose);
    request.raw.socket?.once('close', onClose);

    try {
      // Replay the in-flight turn's events (fenced to just after the last
      // folded turn) and follow live appends. The tail self-terminates on
      // the run's terminal frame; the handles emit `done` / `error` (the
      // route synthesizes `end` outside L2), so we also break on those.
      for await (const event of agenetes.tail(
        canvasAcpNamespace(canvasId ?? ''),
        threadId,
      )) {
        if (clientGone) break;
        writeSSE(reply.raw, event);
        if (
          event.type === AGENT_SSE_EVENTS.Done ||
          event.type === AGENT_SSE_EVENTS.Error ||
          event.type === AGENT_SSE_EVENTS.End
        ) {
          break;
        }
      }
    } finally {
      reply.raw.removeListener('close', onClose);
      request.raw.socket?.removeListener('close', onClose);
      if (!clientGone) reply.raw.end();
    }
  });

  /**
   * GET /agent/threads/:threadId/settings
   * Read the built-in agent's per-thread capability selection (model +
   * reasoning effort) from the thread's durable driver state. `null`
   * fields mean "use the global Settings default".
   */
  fastify.get<{
    Params: { threadId: string };
    Querystring: AgentCanvasIdQuery;
    Reply: ChatThreadSettingsResponse | { message: string };
  }>('/threads/:threadId/settings', async function (request, reply) {
    const { threadId } = request.params;
    const parsedQuery = agentCanvasIdQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply.code(400).send({
        message: parsedQuery.error.issues[0]?.message ?? 'Invalid query',
      });
    }
    return readBuiltinThreadSettings(
      canvasAcpNamespace(parsedQuery.data.canvasId ?? ''),
      threadId,
    );
  });

  /**
   * POST /agent/threads/:threadId/model
   * Set the built-in agent's per-thread model override. Dispatched to the
   * pi driver as a `set_model` control op; persists via the handle's
   * up-report.
   */
  fastify.post<{
    Params: { threadId: string };
    Reply: ChatThreadSettingsResponse | { message: string; code?: string };
  }>('/threads/:threadId/model', async function (request, reply) {
    const { threadId } = request.params;
    const parsed = setChatThreadModelRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: parsed.error.issues[0]?.message ?? 'Invalid request body',
        code: 'validation_failed',
      });
    }
    const namespace = canvasAcpNamespace(parsed.data.canvasId ?? '');
    const result = await dispatchBuiltinControl(namespace, threadId, {
      type: 'set_model',
      data: { modelId: parsed.data.modelId },
    });
    if (!result.ok) {
      return reply
        .code(result.status)
        .send({ message: result.message, code: result.code });
    }
    // Return the corrected settings: switching model may have dropped or
    // clamped a now-incompatible reasoning effort in the driver.
    return readBuiltinThreadSettings(namespace, threadId);
  });

  /**
   * POST /agent/threads/:threadId/reasoning-effort
   * Set the built-in agent's per-thread reasoning effort. Dispatched as a
   * `set_config_option` control op whose optionId matches the pi driver's
   * `reasoning_effort` selector.
   */
  fastify.post<{
    Params: { threadId: string };
    Reply: SetChatThreadSettingResponse | { message: string; code?: string };
  }>('/threads/:threadId/reasoning-effort', async function (request, reply) {
    const { threadId } = request.params;
    const parsed = setChatThreadReasoningEffortRequestSchema.safeParse(
      request.body,
    );
    if (!parsed.success) {
      return reply.code(400).send({
        message: parsed.error.issues[0]?.message ?? 'Invalid request body',
        code: 'validation_failed',
      });
    }
    const result = await dispatchBuiltinControl(
      canvasAcpNamespace(parsed.data.canvasId ?? ''),
      threadId,
      {
        type: 'set_config_option',
        // Must match REASONING_EFFORT_OPTION_ID in the pi driver.
        data: {
          optionId: 'reasoning_effort',
          value: parsed.data.reasoningEffort,
        },
      },
    );
    if (!result.ok) {
      return reply
        .code(result.status)
        .send({ message: result.message, code: result.code });
    }
    return { ok: true };
  });

  /**
   * GET /agent/context-tokens/:threadId
   * Returns the current context token count for a conversation thread.
   *
   * Prefers the provider's authoritative `usage` from the last
   * `AssistantMessage` (input + output = exact size of the context the
   * next turn will re-submit, including system prompt, tool schemas,
   * role overhead and JSON framing). Falls back to a tokenizer estimate
   * of stored message text only on cold start, before any assistant
   * turn has run.
   */
  fastify.get<{
    Params: { threadId: string };
    Querystring: AgentCanvasIdQuery;
    Reply: ApiResult<ContextTokensResponse>;
  }>('/context-tokens/:threadId', async function (request, reply) {
    const { threadId } = request.params;
    const parsedQuery = agentCanvasIdQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply.code(400).send({
        message: parsedQuery.error.issues[0]?.message ?? 'Invalid query',
      });
    }
    const { canvasId } = parsedQuery.data;

    if (!threadId || threadId.trim().length === 0) {
      return reply.code(400).send({ message: 'threadId is required' });
    }

    // Resolve the real window of the currently bound model. Fall back
    // to a conservative GPT-4o-class default if model resolution fails
    // (e.g. unconfigured provider on first run).
    let contextWindow = 128_000;
    try {
      const window = getLLMModel().contextWindow;
      if (typeof window === 'number' && window > 0) contextWindow = window;
    } catch {
      /* keep fallback */
    }

    const { turns } = agenetes.history(
      canvasAcpNamespace(canvasId ?? ''),
      threadId,
    );
    if (turns.length === 0) {
      return reply.send({
        contextTokens: 0,
        contextWindow,
        cost: null,
        fromProvider: false,
      });
    }

    // Provider-reported usage is captured per turn in `meta.usage` (the
    // built-in handle folds `done.meta.usage`; the ACP path reports none).
    // It is opaque `unknown` at the protocol layer, so read it defensively.
    type TurnUsage = {
      input?: number;
      output?: number;
      cost?: { total?: number };
    };

    // ---- Preferred path: provider-reported usage ----
    let lastUsage: TurnUsage | null = null;
    let totalCost = 0;
    for (const turn of turns) {
      const usage = turn.meta?.usage as TurnUsage | undefined;
      if (!usage || typeof usage !== 'object') continue;
      lastUsage = usage;
      const c = usage.cost?.total;
      if (typeof c === 'number' && Number.isFinite(c)) {
        totalCost += c;
      }
    }
    // Only surface cost when at least one turn billed > 0. Providers
    // without per-call billing (e.g. GitHub Copilot OAuth, self-hosted
    // OSS models) report 0 across the board; hiding the field is
    // truer than showing "$0.0000".
    const hasCost = totalCost > 0;

    if (lastUsage) {
      // `input` already includes system prompt + tool schemas + every
      // prior message as the provider tokenizes them; adding `output`
      // gives the size of the assistant turn that will be re-sent on
      // the next call. This matches what the provider will bill.
      const contextTokens = (lastUsage.input ?? 0) + (lastUsage.output ?? 0);
      return reply.send({
        contextTokens,
        contextWindow,
        cost: hasCost ? { amount: totalCost, currency: 'USD' } : null,
        fromProvider: true,
      });
    }

    // Cold start (no assistant turn yet) — no authoritative number
    // exists. Return 0 with `fromProvider: false`; the UI renders an
    // empty ring rather than a misleading tokenizer estimate that
    // would ignore tool schemas, role overhead and JSON framing.
    return reply.send({
      contextTokens: 0,
      contextWindow,
      cost: null,
      fromProvider: false,
    });
  });

  /**
   * POST /agent
   * Unified streaming endpoint for all agent modes.
   */
  fastify.post<{ Body: AgentRequest }>('/', async function (request, reply) {
    const parsed = agentRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ message: parsed.error.issues[0]?.message ?? 'Invalid body' });
    }
    const {
      content,
      threadId,
      mode = 'ask',
      canvasContext,
      canvasId,
      attachments,
      anchorNodeId,
      agentBinding,
      invokedSkills,
      modelId,
      reasoningEffort,
    } = parsed.data;

    const resolvedThreadId = getOrCreateThreadId(threadId);
    const fixedTarget = await agentThreadService.resolveFixedTarget(
      canvasId,
      resolvedThreadId,
    );
    const effectiveBinding = fixedTarget?.agentBinding ?? agentBinding;
    if (effectiveBinding?.kind === 'external') {
      request.log.info(
        {
          threadId: resolvedThreadId,
          canvasId: canvasId ?? null,
          alias: effectiveBinding.alias,
          profileId: effectiveBinding.profileId,
          fixed: fixedTarget !== null,
        },
        'agent.route: external agentBinding → ACP dispatch',
      );
    }

    // Read lightweight L2 log metadata only to number the optional debug
    // prompt dump. Recovery history flows from Agenetes into the selected
    // driver through AgentCreateContext; the host does not load or replay it.
    const { turnCount } = agenetes.logMetadata(
      canvasAcpNamespace(canvasId ?? ''),
      resolvedThreadId,
    );

    // Build this turn's structured envelope (memory pre-read, auto-
    // snapshot, skill resolution, neighbourhood render). The envelope is
    // what we persist AND dispatch; it is rendered into the per-turn user
    // message INSIDE the dispatch layer (runAgent / runAcpAgent), so both
    // backends share one render timing and it never enters the persisted
    // transcript (it is re-derived from the envelope on reload).
    const envelope = await buildChatEnvelope({
      content,
      attachments,
      selectedNodes: canvasContext?.selectedNodes,
      anchorNodeId: fixedTarget?.nodeId ?? anchorNodeId,
      invokedSkills,
      canvasId: canvasId ?? null,
      logger: request.log,
    });
    // Debug-prompt metadata forwarded to the dispatch layer (it assembles
    // the final prompt). No-op unless HUABU_DEBUG_PROMPT is set.
    const debugPrompt = {
      turnNumber: turnCount + 1,
      threadId: resolvedThreadId,
      mode:
        effectiveBinding?.kind === 'external'
          ? `external:${effectiveBinding.alias}`
          : mode,
      logger: request.log,
    };

    let invocation;
    try {
      invocation = await agentThreadService.invoke({
        threadId: resolvedThreadId,
        canvasId,
        content,
        mode,
        envelope,
        requestBinding: agentBinding,
        fixedTarget,
        modelId,
        reasoningEffort,
        logger: request.log,
        debugPrompt,
      });
    } catch (error) {
      if (error instanceof AgentThreadBusyError) {
        return reply.code(409).send({
          message: 'Another turn is already running for this thread.',
          code: 'thread_busy',
        });
      }
      throw error;
    }

    try {
      // SSE streaming
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'X-Accel-Buffering': 'no',
      });
      reply.raw.flushHeaders?.();
      reply.raw.write(': ok\n\n');

      // Send thread ID
      const metaEvent: AgentStreamEvent = {
        type: AGENT_SSE_EVENTS.Meta,
        data: { threadId: resolvedThreadId, mode },
      };
      writeSSE(reply.raw, metaEvent);
    } catch (error) {
      await invocation.dispose(error);
      throw error;
    }

    // Emit an event to the connected client. Reconnecting clients replay
    // from L2's tail (see `/stream`), so there is no host-side buffer or
    // subscriber fan-out to maintain here.
    const emit = (event: AgentStreamEvent) => {
      if (clientConnected) {
        writeSSE(reply.raw, event);
      }
    };

    // Track whether the client is still connected so we can skip SSE writes
    // after disconnect without aborting the pipeline.
    let clientConnected = true;
    const onDisconnect = () => {
      clientConnected = false;
      request.log.info(
        '[agent] Client disconnected — pipeline continues in background',
      );
    };
    const socket = request.raw.socket;
    reply.raw.once('close', onDisconnect);
    socket?.once('close', onDisconnect);

    try {
      // Consume the dispatch stream, forwarding events to the connected
      // client. L2 tees every event into the Tier-1 log and folds the
      // Tier-2 turn on return, so the route no longer collects or persists
      // the transcript. On abort we do NOT `break` (that calls
      // `iterator.return()` and can cut the dispatch short before it emits
      // its terminal frame); we stop forwarding to the client but keep
      // draining so the dispatch settles and L2 folds a complete turn.
      const iterator = invocation.events[Symbol.asyncIterator]();
      while (true) {
        const { value, done } = await iterator.next();
        if (done) break;
        if (invocation.signal.aborted) continue;
        emit(value);
      }

      if (!invocation.signal.aborted) {
        emit({ type: AGENT_SSE_EVENTS.End, data: {} });
      }
    } catch (error) {
      if (!invocation.signal.aborted) {
        request.log.error(error);
        const errorMsg =
          error instanceof Error ? error.message : 'Internal Error';
        emit({ type: AGENT_SSE_EVENTS.Error, data: { error: errorMsg } });
      }
    } finally {
      reply.raw.removeListener('close', onDisconnect);
      socket?.removeListener('close', onDisconnect);
      if (clientConnected) {
        reply.raw.end();
      }
    }
  });
};

export default agentRoutes;
