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

import { emptyAcpOverlay } from '@agenetes/acp-driver';

import {
  AGENT_SSE_EVENTS,
  agentCanvasIdQuerySchema,
  agentRequestSchema,
  createId,
  forkThreadBodySchema,
} from '@sediment/shared';

import { loadAgent } from '../../prompt/index.js';
import { runAcpAgent } from '../agent/acp/service.js';
import { agenetes } from '../agent/agenetes/drivers.js';
import { runAgent } from '../agent/agent.service.js';
import { buildChatEnvelope } from '../agent/conversation/envelope.js';
import { rebuildContextMessages } from '../agent/conversation/prompt/build-prompt.js';
import { buildHistoryFromTurns } from '../agent/conversation/transcript/history.js';
import { getLLMModel } from '../agent/llm.js';
import { readWorkspaceMemory } from '../agent/memory/index.js';
import { canvasAcpNamespace } from '../storage/paths.js';

import type { AgentTurn } from '@agenetes/protocol';
import type { Context } from '@earendil-works/pi-ai';
import type {
  AgentCanvasIdQuery,
  AgentRequest,
  AgentStreamEvent,
  ApiResult,
  ChatHistoryItem,
  ChatHistoryResponse,
  ContextTokensResponse,
  ForkThreadBody,
  ForkThreadResponse,
  StopThreadResponse,
} from '@sediment/shared';
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

/**
 * Rebuild the pi-ai {@link Context} a BUILT-IN agent turn runs over from
 * the thread's prior turns. Built-in only: `runAgent` is stateless per
 * turn, so this `systemPrompt` + rebuilt `messages` IS its memory. The
 * ACP path keeps memory in its live session (`ensureAcpSession`) and gets
 * no Context.
 *
 * Takes `priorTurns` (already loaded by the caller for the debug turn
 * count) to avoid a second history read.
 */
function buildAgentSystemPrompt(params: {
  canvasId: string | undefined;
  mode: Parameters<typeof loadAgent>[0];
}): string {
  const { canvasId, mode } = params;
  // We re-render the agent's system prompt on every turn so the
  // `{{skillCatalogue}}` placeholder reflects freshly written user
  // skills. `canvasId` flows into `loadAgent({ canvasId })` for
  // forward compatibility with future per-canvas template vars.
  const agentCfg = loadAgent(mode, { canvasId });

  // Workspace memory (cross-canvas user profile) is part of the agent's
  // stable system instructions, so it rides in the system prompt as a
  // tagged block — grounding every turn and staying cache-friendly —
  // rather than as a one-shot first-turn user message.
  const workspaceMemory = readWorkspaceMemory();
  return workspaceMemory
    ? `${agentCfg.systemPrompt}\n\n<workspace_memory>\n${workspaceMemory}\n</workspace_memory>`
    : agentCfg.systemPrompt;
}

async function resumeThreadContext(params: {
  priorTurns: readonly AgentTurn[];
  canvasId: string | undefined;
  mode: Parameters<typeof loadAgent>[0];
}): Promise<Context> {
  const { priorTurns, canvasId, mode } = params;

  const systemPrompt = buildAgentSystemPrompt({ canvasId, mode });

  // Rebuild `Context.messages` by re-serialising each prior turn's
  // envelope + appending its transcript. The `[SYSTEM …]` encoding is
  // regenerated here on the fly — it is never the source of truth on disk.
  return {
    systemPrompt,
    messages: await rebuildContextMessages(priorTurns, {
      canvasId: canvasId ?? null,
    }),
    tools: [],
  };
}

// ==================== Route ====================

/**
 * State for an active agent run. Reconnecting clients now replay from
 * L2's Tier-1 event log (`agenetes.tail`), so the host keeps only the
 * abort handle + a completion flag needed by `/stop` and `/stream`.
 */
interface ActiveRun {
  abortController: AbortController;
  /** Whether the run has finished (success, error, or abort). */
  completed: boolean;
}

/**
 * Tracks active (and recently completed) agent runs by threadId.
 * Enables client reconnection after page refresh.
 */
const activeRuns = new Map<string, ActiveRun>();

/** Remove a completed run after a grace period. */
function scheduleRunCleanup(threadId: string, delayMs = 60_000): void {
  setTimeout(() => {
    const run = activeRuns.get(threadId);
    if (run?.completed) activeRuns.delete(threadId);
  }, delayMs);
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

    const { turns } = agenetes.history(
      canvasAcpNamespace(canvasId ?? ''),
      threadId,
    );
    if (turns.length === 0) {
      // No folded turns → empty/new thread.
      return reply.send({ threadId, messages: [] });
    }

    const messages: ChatHistoryItem[] = [];
    buildHistoryFromTurns(turns, messages);

    return reply.send({ threadId, messages });
  });

  /**
   * POST /agent/history/:threadId/fork
   *
   * Legacy feature (M6.95 known issue: unsupported legacy features).
   * Historically this copied a thread's persisted conversation onto a
   * fresh thread id so a duplicated question node owned an independent
   * continuation. With L2 owning the conversation log, cross-thread copy
   * is not yet reimplemented, so this degrades gracefully to a no-op
   * (`forked: false`) instead of half-copying state.
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
    if (targetThreadId === threadId && dstCanvasId === canvasId) {
      return reply
        .code(400)
        .send({ message: 'target thread must differ from source' });
    }

    // Fork is a legacy feature not yet reimplemented over the L2-owned
    // conversation log (M6.95 known issue). Rather than half-copy state,
    // degrade gracefully to a no-op so the duplicated node simply starts
    // as a fresh thread; the client surfaces this via `forked: false`.
    return reply.send({ threadId: targetThreadId, forked: false });
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
    const run = activeRuns.get(threadId);
    if (run && !run.abortController.signal.aborted) {
      run.abortController.abort();
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
    const run = activeRuns.get(threadId);

    // Only reconnect to runs that are still in progress. Completed runs
    // are fully folded into the Tier-2 log, so the history endpoint
    // returns complete data — no need to replay a live tail.
    if (!run || run.completed) {
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
    // TODO: `request.body.intentData` is sent by
    // the client (see `apps/web/src/api/agent.ts` and
    // `apps/web/src/hooks/useAgentStream.ts`) but is intentionally NOT
    // destructured here — it is silently dropped. Either inject it as a
    // `[SYSTEM IntentSelect]` user-role message before `runAgent`, or
    // remove `intentData` from `AgentRequest` and the client.
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
    } = parsed.data;

    // Log the thread→agent binding so external dispatches are visible
    // in the server log. When `kind === 'external'`, the dispatch below
    // routes to `runAcpAgent` instead of the built-in pi-agent-core loop.
    if (agentBinding && agentBinding.kind === 'external') {
      request.log.info(
        {
          threadId: threadId ?? null,
          canvasId: canvasId ?? null,
          alias: agentBinding.alias,
          profileId: agentBinding.profileId,
        },
        'agent.route: external agentBinding → ACP dispatch',
      );
    }

    const resolvedThreadId = getOrCreateThreadId(threadId);

    // Load the thread's prior folded turns from L2 (the single source of
    // truth). Both backends need this: `priorTurns.length` drives the
    // debug turn number, and the built-in path uses them as the cold-start
    // recovery seed when no live Deployment handle exists. A crashed
    // in-flight turn is folded by L2 on next append; no host-side
    // active-turn finalize is required.
    const { turns: priorTurns } = agenetes.history(
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
      anchorNodeId,
      invokedSkills,
      canvasId: canvasId ?? null,
      logger: request.log,
    });

    // Debug-prompt metadata forwarded to the dispatch layer (it assembles
    // the final prompt). No-op unless HUABU_DEBUG_PROMPT is set.
    const debugPrompt = {
      turnNumber: priorTurns.length + 1,
      threadId: resolvedThreadId,
      mode:
        agentBinding?.kind === 'external'
          ? `external:${agentBinding.alias}`
          : mode,
      logger: request.log,
    };

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

    // Abort controller — only triggered by the explicit /stop endpoint,
    // NOT by client disconnect (so page refreshes don't interrupt the run).
    const abortController = new AbortController();
    const run: ActiveRun = {
      abortController,
      completed: false,
    };
    activeRuns.set(resolvedThreadId, run);

    // `acpOverlay`: tool extensions + plan, mutated by `runAcpAgent` only.
    // Persistence is now owned entirely by L2 (the dispatch runs through
    // `agenetes.create(spec).run(...)`, which tees every event into the
    // Tier-1 log and folds the Tier-2 turn on return), so the route no
    // longer builds or writes any turn record.
    const acpOverlay = emptyAcpOverlay();

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
      // Route dispatch: external bindings go to `runAcpAgent`, everything
      // else (including missing/`internal` bindings) goes to the built-in
      // pi-agent-core loop. Both paths yield the same `AgentStreamEvent`
      // shape so the consume loop below is binding-agnostic.
      let stream: AsyncGenerator<AgentStreamEvent, unknown>;
      if (agentBinding?.kind === 'external') {
        stream = runAcpAgent({
          binding: {
            alias: agentBinding.alias,
            profileId: agentBinding.profileId,
          },
          threadId: resolvedThreadId,
          canvasId,
          envelope,
          overlay: acpOverlay,
          signal: abortController.signal,
          logger: request.log,
          debugPrompt,
        });
      } else {
        // Built-in path: if a live Deployment handle already exists, keep
        // using its in-memory transcript and only refresh the current
        // system prompt; otherwise cold-start from durable history.
        const liveHandle = agenetes.get(resolvedThreadId);
        const context = liveHandle
          ? {
              systemPrompt: buildAgentSystemPrompt({ canvasId, mode }),
              messages: [],
              tools: [],
            }
          : await resumeThreadContext({
              priorTurns,
              canvasId,
              mode,
            });
        stream = runAgent({
          scope: mode,
          workloadType: 'Deployment',
          // The built-in chat agent's canvas writes are delivered to the
          // frontend ONLY via the sync broadcast (like ACP), not applied
          // from the chat tool result. Attributing them to the chat
          // `threadId` feeds the per-thread change card (ChangeReviewCard)
          // that owns revert for this agent.
          threadId: resolvedThreadId,
          canvasId,
          envelope,
          context,
          maxIterations: 20,
          signal: abortController.signal,
          logger: request.log,
          debugPrompt,
        });
      }

      // Consume the dispatch stream, forwarding events to the connected
      // client. L2 tees every event into the Tier-1 log and folds the
      // Tier-2 turn on return, so the route no longer collects or persists
      // the transcript. On abort we do NOT `break` (that calls
      // `iterator.return()` and can cut the dispatch short before it emits
      // its terminal frame); we stop forwarding to the client but keep
      // draining so the dispatch settles and L2 folds a complete turn.
      const iterator = stream[Symbol.asyncIterator]();
      while (true) {
        const { value, done } = await iterator.next();
        if (done) break;
        if (abortController.signal.aborted) continue;
        emit(value);
      }

      if (!abortController.signal.aborted) {
        emit({ type: AGENT_SSE_EVENTS.End, data: {} });
      }
    } catch (error) {
      if (!abortController.signal.aborted) {
        request.log.error(error);
        const errorMsg =
          error instanceof Error ? error.message : 'Internal Error';
        emit({ type: AGENT_SSE_EVENTS.Error, data: { error: errorMsg } });
      }
    } finally {
      run.completed = true;
      scheduleRunCleanup(resolvedThreadId);
      reply.raw.removeListener('close', onDisconnect);
      socket?.removeListener('close', onDisconnect);
      if (clientConnected) {
        reply.raw.end();
      }
    }
  });
};

export default agentRoutes;
