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
  variantForInternalTool,
} from '@sediment/shared';

import { loadAgent } from '../../prompt/index.js';
import { runAcpAgent } from '../agent/acp/service.js';
import { runAgent } from '../agent/agent.service.js';
import {
  rebuildContextMessages,
  renderEnvelopeMessages,
} from '../agent/context/chat-turn.js';
import { buildChatEnvelope } from '../agent/context/envelope.js';
import { getLLMModel } from '../agent/llm.js';
import {
  appendTurn,
  clearActiveTurn,
  emptyAcpOverlay,
  finalizeActiveTurn,
  loadTurns,
  writeActiveTurn,
} from '../agent/store/chat-thread-store.js';
import { projectUserVisibleAttachments } from '../agent/user-message-metadata.js';

import type {
  ChatTurnRecord,
  PiMessage,
  ToolAcpExtension,
} from '../agent/store/chat-thread-store.js';
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import type {
  AgentCanvasIdQuery,
  AgentRequest,
  AgentStreamEvent,
  ApiResult,
  AssistantHistoryPart,
  ChatAttachment,
  ChatHistoryItem,
  ChatHistoryResponse,
  ContextTokensResponse,
  ExternalAgentPrompt,
  ImageGenerationData,
  SnapshotNodesData,
  StopThreadResponse,
  ToolResponse,
  WebSearchToolResponse,
} from '@sediment/shared';
import type { FastifyPluginAsync } from 'fastify';

// ==================== Helpers ====================

function getOrCreateThreadId(value: unknown): string {
  if (typeof value === 'string' && value.trim().length > 0) return value;
  return createId('thread');
}

function writeSSE(raw: NodeJS.WritableStream, event: AgentStreamEvent): void {
  raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
}

/**
 * Clean up context after an abort.
 *
 * Keeps all completed messages (user prompt, partial assistant text,
 * finished tool calls and results) — these are visible to the user and
 * may have already affected the canvas.
 *
 * Only repairs the broken tail:
 * 1. If the last assistant message requested tool calls that never got
 *    results, strip those orphaned toolCall entries so the LLM doesn't
 *    see an invalid conversation state.
 * 2. Append an interruption notice telling the LLM not to resume.
 */
function cleanUpAbortedContext(context: Context): void {
  const msgs = context.messages;

  // Collect IDs of all toolResults we have
  const completedCallIds = new Set<string>();
  for (const m of msgs) {
    if (m.role === 'toolResult') {
      completedCallIds.add(m.toolCallId);
    }
  }

  // Find the last assistant message and strip orphaned toolCalls
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === 'assistant') {
      const assistant = m as AssistantMessage;
      const hadToolCalls = assistant.content.some((b) => b.type === 'toolCall');
      if (hadToolCalls) {
        // Keep only text/thinking content + toolCalls that have results
        assistant.content = assistant.content.filter(
          (b) => b.type !== 'toolCall' || completedCallIds.has(b.id),
        );
        // If all toolCalls were removed, fix stopReason so LLM doesn't
        // expect more tool results.
        const remainingCalls = assistant.content.filter(
          (b) => b.type === 'toolCall',
        );
        if (remainingCalls.length === 0) {
          assistant.stopReason = 'stop';
        }
      }
      break;
    }
  }

  // Append interruption notice
  msgs.push({
    role: 'user',
    content:
      '[SYSTEM Interrupted] The user interrupted the previous operation. ' +
      'Do NOT continue or retry the interrupted task. ' +
      'Wait for the next user message and treat it as a new request.',
    timestamp: Date.now(),
  });
}

// ==================== Route ====================

/** State for an active agent run, supporting client reconnection. */
interface ActiveRun {
  abortController: AbortController;
  /** All events emitted so far — replayed to reconnecting clients. */
  eventBuffer: AgentStreamEvent[];
  /** Live subscribers (reconnected SSE clients). */
  subscribers: Set<(event: AgentStreamEvent) => void>;
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

/**
 * Parse a pi-ai tool-result text payload into the canonical
 * `ToolResponse<…>` envelope. Mirrors the legacy `role:'tool'`
 * reconstruction logic — preserved here because every rich-variant
 * tool part carries this envelope as its `data` field.
 */
function parseToolResultText(
  toolName: string,
  resultText: string,
): ToolResponse<string, unknown> {
  try {
    const parsed = JSON.parse(resultText);
    if (
      parsed &&
      typeof parsed === 'object' &&
      'tool' in parsed &&
      'status' in parsed
    ) {
      return parsed as ToolResponse<string, unknown>;
    }
    // `snapshot_nodes` returns a bare array; wrap it under `snapshots`
    // so the rich `SnapshotNodesToolPart.data.data` carries a stable
    // object shape (matching what the live stream merger produces).
    if (toolName === 'snapshot_nodes' && Array.isArray(parsed)) {
      return {
        tool: toolName,
        status: 'success',
        data: { snapshots: parsed },
      };
    }
    return {
      tool: toolName,
      status: 'success',
      data: parsed,
    };
  } catch {
    return {
      tool: toolName,
      status: 'success',
      data: { content: resultText },
    };
  }
}

/**
 * Index the `toolResult` messages in a message list by `toolCallId`,
 * so an assistant `toolCall` block can find its result in O(1).
 */
function indexToolResults(
  msgs: readonly PiMessage[],
): Map<string, { toolName: string; resultText: string }> {
  const map = new Map<string, { toolName: string; resultText: string }>();
  for (const m of msgs) {
    if (m.role === 'toolResult') {
      const resultText = m.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('');
      map.set(m.toolCallId, { toolName: m.toolName ?? 'unknown', resultText });
    }
  }
  return map;
}

/** Extract the text of a (possibly multipart) user message. */
function extractUserText(msg: Extract<PiMessage, { role: 'user' }>): string {
  return typeof msg.content === 'string'
    ? msg.content
    : Array.isArray(msg.content)
      ? msg.content
          .filter(
            (b): b is { type: 'text'; text: string } =>
              typeof b === 'object' && b !== null && b.type === 'text',
          )
          .map((b) => b.text)
          .join('\n')
      : '';
}

/**
 * Build the ordered `AssistantHistoryPart[]` for one pi-ai assistant
 * message: text / thinking blocks plus tool segments folded in by
 * `toolCallId`. The ACP overlay (`toolExtras`) supplies the semantic
 * fields; the matching pi-ai `toolResult` (when present) supplies the
 * typed `data` envelope for built-in tools. Plans are NOT appended
 * here — the caller owns plan placement (turn-level).
 */
function buildAssistantParts(
  msg: AssistantMessage,
  toolResultByCallId: Map<string, { toolName: string; resultText: string }>,
  toolExtras: Record<string, ToolAcpExtension> | undefined,
): AssistantHistoryPart[] {
  const parts: AssistantHistoryPart[] = [];
  for (const block of msg.content) {
    if (block.type === 'text') {
      if (block.text.length > 0) {
        parts.push({ kind: 'text', text: block.text });
      }
    } else if (block.type === 'thinking') {
      if (block.thinking.length > 0) {
        parts.push({ kind: 'thinking', text: block.thinking });
      }
    } else if (block.type === 'toolCall') {
      const toolCallId = block.id;
      const toolName = block.name;
      const result = toolResultByCallId.get(toolCallId);
      const extras = toolExtras?.[toolCallId];
      // Structural internal-vs-external discriminator: the internal
      // pi-ai bridge pushes a matching `toolResult`; the ACP path does
      // not. So the presence of `result` is itself the signal.
      const toolData = result
        ? parseToolResultText(toolName, result.resultText)
        : undefined;
      const variant = toolData ? variantForInternalTool(toolName) : 'generic';
      const base = {
        kind: 'tool' as const,
        toolCallId,
        title: toolName,
        ...(extras?.toolKind ? { toolKind: extras.toolKind } : {}),
        ...(extras?.status ? { status: extras.status } : {}),
        ...(extras?.locations ? { locations: extras.locations } : {}),
        ...(extras?.content ? { content: extras.content } : {}),
        ...(extras?.rawOutput !== undefined
          ? { rawOutput: extras.rawOutput }
          : {}),
        ...(extras?.permission ? { permission: extras.permission } : {}),
      };
      switch (variant) {
        case 'agent_tool':
          parts.push({
            ...base,
            variant: 'agent_tool',
            toolName,
            ...(toolData ? { data: toolData } : {}),
          });
          break;
        case 'canvas_commands':
          parts.push({
            ...base,
            variant: 'canvas_commands',
            ...(toolData
              ? {
                  data: toolData as ToolResponse<
                    'canvas_commands',
                    Record<string, unknown>
                  >,
                }
              : {}),
          });
          break;
        case 'web_search':
          parts.push({
            ...base,
            variant: 'web_search',
            ...(toolData ? { data: toolData as WebSearchToolResponse } : {}),
          });
          break;
        case 'image_generation':
          parts.push({
            ...base,
            variant: 'image_generation',
            ...(toolData
              ? {
                  data: toolData as ToolResponse<
                    'generate_image',
                    ImageGenerationData
                  >,
                }
              : {}),
          });
          break;
        case 'snapshot_nodes':
          parts.push({
            ...base,
            variant: 'snapshot_nodes',
            ...(toolData
              ? {
                  data: toolData as ToolResponse<
                    'snapshot_nodes',
                    SnapshotNodesData
                  >,
                }
              : {}),
          });
          break;
        case 'generic':
          parts.push({ ...base, variant: 'generic' });
          break;
      }
    }
  }
  return parts;
}

/**
 * Convert the structured per-turn records into `ChatHistoryItem`
 * entries for the client.
 *
 * Each turn emits a user item directly from its {@link ChatEnvelope}
 * (no `[SYSTEM …]` tag stripping — selection / skills / attachments
 * are already structured fields) followed by the assistant/tool/status
 * items reconstructed from the turn's transcript. Message ORDER comes
 * from the transcript array; the ACP overlay (`turn.toolExtras` /
 * `turn.plan`) joins by stable `toolCallId` and is turn-level — no
 * timestamps, no position arrays, no separate sidecar.
 */
function buildHistoryFromTurns(
  turns: readonly ChatTurnRecord[],
  messages: ChatHistoryItem[],
): void {
  for (const turn of turns) {
    const env = turn.envelope;

    // 1. User item, straight from the structured envelope.
    const allAttachments = [
      ...env.user.attachments,
      ...env.focus.selection.imageAttachments,
      ...env.focus.selection.snapshotAttachments,
    ];
    const attachments = projectUserVisibleAttachments(
      allAttachments,
      env.focus.selection.selectedIds,
    );
    const selectedNodeIds = env.focus.selection.selectedIds;
    const invokedSkills = env.skills.invokedIds;
    if (
      env.user.text.trim() ||
      attachments.length > 0 ||
      selectedNodeIds.length > 0
    ) {
      messages.push({
        role: 'user',
        content: env.user.text,
        ...(attachments.length > 0 && {
          attachments: attachments as ChatAttachment[],
        }),
        ...(selectedNodeIds.length > 0 && { selectedNodeIds }),
        ...(invokedSkills.length > 0 && { invokedSkills }),
      });
    }

    // 2. Transcript: assistant / tool / status items.
    let pendingStatus: ChatHistoryItem | null = null;
    let currentAssistant: Extract<
      ChatHistoryItem,
      { role: 'assistant' }
    > | null = null;
    const flushStatus = () => {
      if (pendingStatus) {
        messages.push(pendingStatus);
        pendingStatus = null;
        currentAssistant = null;
      }
    };

    const toolResultByCallId = indexToolResults(turn.transcript);
    const toolExtras = turn.toolExtras;

    for (const msg of turn.transcript) {
      if (msg.role === 'user') {
        // Only `[SYSTEM …]` status / prepared-prompt rows appear in a
        // transcript — the real user message is the envelope above.
        const content = extractUserText(msg).trim();
        if (content.startsWith('[SYSTEM Interrupted]')) {
          pendingStatus = { role: 'status', status: 'interrupted' };
          continue;
        }
        if (content.startsWith('[SYSTEM Error]')) {
          const detail = content.slice('[SYSTEM Error] '.length);
          pendingStatus = { role: 'status', status: 'error', detail };
          continue;
        }
        if (content.startsWith('[SYSTEM PreparedPrompt]')) {
          flushStatus();
          const payload = content.slice('[SYSTEM PreparedPrompt] '.length);
          try {
            const parsed = JSON.parse(payload) as {
              agentAlias: string;
              prompt: ExternalAgentPrompt | null;
              error?: string;
            };
            messages.push({
              role: 'prepared-prompt',
              agentAlias: parsed.agentAlias,
              prompt: parsed.prompt,
              ...(parsed.error ? { error: parsed.error } : {}),
            });
            currentAssistant = null;
          } catch {
            // Malformed — drop silently rather than break history.
          }
          continue;
        }
        // Any other unexpected user-role row in a transcript is ignored.
        continue;
      } else if (msg.role === 'assistant') {
        const parts = buildAssistantParts(msg, toolResultByCallId, toolExtras);
        if (parts.length > 0) {
          if (currentAssistant) {
            currentAssistant.parts.push(...parts);
          } else {
            const item: Extract<ChatHistoryItem, { role: 'assistant' }> = {
              role: 'assistant',
              parts,
            };
            messages.push(item);
            currentAssistant = item;
          }
        }
        flushStatus();
      }
      // toolResult: folded into the assistant turn via toolCallId.
    }

    // Turn-level plan (folded ACP overlay): appended once at the end.
    if (turn.plan && turn.plan.length > 0 && currentAssistant) {
      currentAssistant.parts.push({ kind: 'plan', entries: turn.plan });
    }

    flushStatus();
  }
}

const agentRoutes: FastifyPluginAsync = async (
  fastify,
  _opts,
): Promise<void> => {
  /**
   * GET /agent/history/:threadId
   * Reconstructs the UI message list from the structured per-turn
   * records (envelope + transcript).
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

    const turns = loadTurns(threadId, canvasId);
    if (turns.length === 0) {
      // No history for this threadId — return empty. Expected for newly
      // created threads (e.g. after "New Chat") that haven't sent a
      // message yet, and for legacy threads whose `.json` Context is no
      // longer read (structured-persistence cutover).
      return reply.send({ threadId, messages: [] });
    }

    const messages: ChatHistoryItem[] = [];
    buildHistoryFromTurns(turns, messages);

    return reply.send({ threadId, messages });
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
   * Reconnect to an active (or recently completed) agent run.
   * Replays buffered events, then streams new events live.
   */
  fastify.get<{ Params: { threadId: string } }>(
    '/stream/:threadId',
    async function (request, reply) {
      const { threadId } = request.params;
      const run = activeRuns.get(threadId);

      // Only reconnect to runs that are still in progress.
      // Completed runs have already been fully persisted via flushSave(),
      // so the history endpoint returns complete data — no need to replay.
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

      // Replay all buffered events
      for (const ev of run.eventBuffer) {
        writeSSE(reply.raw, ev);
      }

      // Subscribe for new live events
      const subscriber = (event: AgentStreamEvent) => {
        writeSSE(reply.raw, event);
        if (
          event.type === AGENT_SSE_EVENTS.End ||
          event.type === AGENT_SSE_EVENTS.Error
        ) {
          reply.raw.end();
          run.subscribers.delete(subscriber);
        }
      };
      run.subscribers.add(subscriber);

      // Clean up if this client disconnects
      const cleanup = () => run.subscribers.delete(subscriber);
      reply.raw.once('close', cleanup);
      request.raw.socket?.once('close', cleanup);
    },
  );

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

    const turns = loadTurns(threadId, canvasId);
    if (turns.length === 0) {
      return reply.send({
        contextTokens: 0,
        contextWindow,
        cost: null,
        fromProvider: false,
      });
    }
    // Provider-reported usage lives on the assistant messages in each
    // turn's transcript.
    const transcriptMessages = turns.flatMap((t) => t.transcript);

    // ---- Preferred path: provider-reported usage ----
    let lastUsage: AssistantMessage['usage'] | null = null;
    let totalCost = 0;
    let hasCost = false;
    for (const msg of transcriptMessages) {
      if (msg.role !== 'assistant') continue;
      const am = msg as AssistantMessage;
      if (am.usage) {
        lastUsage = am.usage;
        const c = am.usage.cost?.total;
        if (typeof c === 'number' && Number.isFinite(c)) {
          totalCost += c;
        }
      }
    }
    // Only surface cost when at least one turn billed > 0. Providers
    // without per-call billing (e.g. GitHub Copilot OAuth, self-hosted
    // OSS models) report 0 across the board; hiding the field is
    // truer than showing "$0.0000".
    hasCost = totalCost > 0;

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

    // Build or resume context from the structured turn log.
    //
    // We re-render the agent's system prompt on every turn so the
    // `{{skillCatalogue}}` placeholder reflects freshly written user
    // skills. `canvasId` flows into `loadAgent({ canvasId })` for
    // forward compatibility with future per-canvas template vars.
    const agentCfg = loadAgent(mode, { canvasId });

    // Commit any crash-leftover in-progress turn before starting a new
    // one, then rebuild the pi-ai `Context.messages` the agent runs over
    // by re-serialising each prior turn's envelope + appending its
    // transcript. The `[SYSTEM …]` encoding is regenerated here on the
    // fly — it is never the source of truth on disk.
    finalizeActiveTurn(resolvedThreadId, canvasId);
    const priorTurns = loadTurns(resolvedThreadId, canvasId);
    const isFirstTurn = priorTurns.length === 0;
    const context: Context = {
      systemPrompt: agentCfg.systemPrompt,
      messages: await rebuildContextMessages(priorTurns, {
        canvasId: canvasId ?? null,
        agentCfg,
      }),
      tools: [],
    };

    // Build this turn's structured envelope (memory pre-read, auto-
    // snapshot, skill resolution, neighbourhood render) and render it
    // into the per-turn user messages the agent sees. The envelope is
    // what we persist; the rendered messages are transient.
    const env = await buildChatEnvelope({
      content,
      attachments,
      selectedNodes: canvasContext?.selectedNodes,
      anchorNodeId,
      invokedSkills,
      canvasId: canvasId ?? null,
      isFirstTurn,
      logger: request.log,
    });
    const { messages: userMessages, userContent } =
      await renderEnvelopeMessages(env, {
        canvasId: canvasId ?? null,
        agentCfg,
      });
    context.messages.push(...userMessages);
    // Index where this turn's transcript begins: everything the agent
    // appends from here on (assistant / tool / status rows) is the
    // transcript we persist alongside the envelope.
    const transcriptStart = context.messages.length;

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
      eventBuffer: [metaEvent],
      subscribers: new Set(),
      completed: false,
    };
    activeRuns.set(resolvedThreadId, run);

    // Per-turn ACP overlay (tool extensions + plan). Empty for internal
    // turns; mutated by `runAcpAgent` for external-agent dispatch and
    // folded into the persisted turn record below.
    const acpOverlay = emptyAcpOverlay();
    const buildTurnRecord = (): ChatTurnRecord => ({
      envelope: env,
      transcript: context.messages.slice(transcriptStart),
      ...(Object.keys(acpOverlay.toolExtras).length > 0 && {
        toolExtras: acpOverlay.toolExtras,
      }),
      ...(acpOverlay.plan &&
        acpOverlay.plan.length > 0 && {
          plan: acpOverlay.plan,
        }),
    });

    // Persist this turn's in-progress state (envelope + transcript so
    // far) to the active sidecar. The finalized JSONL log is appended
    // only once, when the turn completes (see `finalizeTurn` below), so
    // streaming saves never rewrite the whole thread.
    const persistActiveTurn = () => {
      writeActiveTurn(resolvedThreadId, buildTurnRecord(), canvasId);
    };
    const finalizeTurn = () => {
      appendTurn(resolvedThreadId, buildTurnRecord(), canvasId);
      clearActiveTurn(resolvedThreadId, canvasId);
    };

    // Save immediately so history includes the user message on refresh.
    persistActiveTurn();

    // Debounced save — keeps disk copy fresh during streaming so
    // refreshes always see partial progress. Flushes at most every 2 seconds.
    let savePending = false;
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    const debouncedSave = () => {
      savePending = true;
      if (!saveTimer) {
        saveTimer = setTimeout(() => {
          saveTimer = null;
          if (savePending) {
            savePending = false;
            persistActiveTurn();
          }
        }, 2000);
      }
    };
    const flushSave = () => {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      persistActiveTurn();
    };

    // Emit an event: buffer it, write to original client, forward to subscribers.
    const emit = (event: AgentStreamEvent) => {
      run.eventBuffer.push(event);
      if (clientConnected) {
        writeSSE(reply.raw, event);
      }
      for (const sub of run.subscribers) {
        sub(event);
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
      // shape so the for-await loop below is binding-agnostic.
      const stream: AsyncIterable<AgentStreamEvent> =
        agentBinding?.kind === 'external'
          ? runAcpAgent({
              binding: {
                alias: agentBinding.alias,
                profileId: agentBinding.profileId,
              },
              message: userContent,
              threadId: resolvedThreadId,
              canvasId,
              context,
              overlay: acpOverlay,
              canvasContext,
              signal: abortController.signal,
              logger: request.log,
            })
          : runAgent({
              scope: mode,
              canvasId,
              context,
              logger: request.log,
              maxIterations: 20,
              signal: abortController.signal,
            });

      // Track the latest agent error so we can persist it AFTER the stream
      // exits. We can't push into `context.messages` mid-loop because the
      // pi-agent-core wrapper in `runAgent()` performs a final
      // `context.messages = [...agent.state.messages]` sync in its `finally`
      // block — which would wipe anything we pushed inside the loop.
      // Persisting after the loop ensures `buildHistoryItems()` can
      // reconstruct the error status row on history reload.
      let lastErrorDetail: string | null = null;

      for await (const event of stream) {
        if (abortController.signal.aborted) break;
        emit(event);

        // Capture the latest error; we persist it post-loop (see comment above).
        if (event.type === AGENT_SSE_EVENTS.Error && event.data.error) {
          lastErrorDetail = event.data.error;
        }

        // Periodically save context so partial progress survives refreshes
        debouncedSave();
      }

      // Persist the agent error AFTER the for-await exits — by which point
      // runAgent's `finally` has already synced agent.state.messages back
      // into `context.messages`, so our push survives the final flushSave.
      if (lastErrorDetail) {
        context.messages.push({
          role: 'user',
          content: `[SYSTEM Error] ${lastErrorDetail}`,
          timestamp: Date.now(),
        });
      }

      // On explicit abort (user clicked stop), clean up context.
      // Partial assistant text streamed before abort is already preserved
      // by pi-agent-core: its agent-loop finalizes the in-flight message
      // via `response.result()` (with `stopReason: 'aborted'`) and pushes
      // it to `state.messages`, which `runAgent`'s finally syncs back
      // into `context.messages`. No re-injection needed here.
      if (abortController.signal.aborted) {
        request.log.info(
          '[agent] Abort detected — cleaning up context (%d messages before cleanup)',
          context.messages.length,
        );
        cleanUpAbortedContext(context);
        request.log.info(
          '[agent] Context cleaned up (%d messages after cleanup)',
          context.messages.length,
        );
      }

      // Final save — flush any pending debounce and persist the complete context
      flushSave();

      // Log final context state for debugging
      const lastMsgs = context.messages.slice(-3).map((m) => ({
        role: m.role,
        ...(m.role === 'user'
          ? {
              content:
                typeof m.content === 'string'
                  ? m.content.slice(0, 100)
                  : '[multipart]',
            }
          : {}),
        ...(m.role === 'assistant'
          ? {
              stopReason: (m as AssistantMessage).stopReason,
              contentTypes: (m as AssistantMessage).content.map((b) => b.type),
            }
          : {}),
        ...(m.role === 'toolResult' ? { toolName: m.toolName } : {}),
      }));
      request.log.info(
        { totalMessages: context.messages.length, lastMessages: lastMsgs },
        '[agent] Context saved for thread %s',
        resolvedThreadId,
      );

      if (!abortController.signal.aborted) {
        emit({ type: AGENT_SSE_EVENTS.End, data: {} });
      }
    } catch (error) {
      if (!abortController.signal.aborted) {
        request.log.error(error);
        const errorMsg =
          error instanceof Error ? error.message : 'Internal Error';
        emit({ type: AGENT_SSE_EVENTS.Error, data: { error: errorMsg } });

        // Persist error in the transcript so it shows up on history reload
        context.messages.push({
          role: 'user',
          content: `[SYSTEM Error] ${errorMsg}`,
          timestamp: Date.now(),
        });
        persistActiveTurn();
      }
    } finally {
      // Promote the in-progress turn to the append-only JSONL log and
      // clear the active sidecar — by now `context.messages` reflects
      // the final state (error rows, abort cleanup, agent output).
      finalizeTurn();
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
