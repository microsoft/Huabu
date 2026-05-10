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

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  AGENT_SSE_EVENTS,
  agentCanvasIdQuerySchema,
  agentRequestSchema,
  createId,
} from '@sediment/shared';
import { encode } from 'gpt-tokenizer';

import { buildAgentPrompt } from '../../prompt/agent.js';
import { IMAGE_MIME_MAP } from '../../utils/mime.js';
import { runAgent } from '../agent/agent.service.js';
import { loadContext, saveContext } from '../agent/store/chat-store.js';
import { ARTIFACT_URL_REGEX } from '../artifact/utils.js';
import { getCanvasStore } from '../storage/index.js';

import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import type {
  AgentCanvasIdQuery,
  AgentRequest,
  AgentStreamEvent,
  ApiResult,
  ChatAttachment,
  ChatHistoryItem,
  ChatHistoryResponse,
  ContextTokensResponse,
  SelectedNodeDetail,
  StopThreadResponse,
  ToolResponse,
} from '@sediment/shared';
import type { FastifyPluginAsync } from 'fastify';

// ==================== Helpers ====================

function getOrCreateThreadId(value: unknown): string {
  if (typeof value === 'string' && value.trim().length > 0) return value;
  return createId('thread');
}

async function resolveImageUrl(url: string): Promise<string> {
  if (url.startsWith('data:')) return url;

  const artifactMatch = ARTIFACT_URL_REGEX.exec(url);
  if (artifactMatch) {
    const canvasId = artifactMatch[1];
    const filename = path.basename(artifactMatch[2]);
    let artifactsDir: string;
    try {
      artifactsDir = getCanvasStore(canvasId).artifactsDir();
    } catch {
      return url;
    }
    const filePath = path.resolve(artifactsDir, filename);

    if (!filePath.startsWith(path.resolve(artifactsDir))) {
      console.warn(`Blocked path traversal attempt: ${artifactMatch[2]}`);
      return url;
    }

    try {
      const buffer = await readFile(filePath);
      const ext = path.extname(filename).toLowerCase();
      const mime = IMAGE_MIME_MAP[ext] ?? 'image/png';
      return `data:${mime};base64,${buffer.toString('base64')}`;
    } catch {
      return url;
    }
  }

  // Fetch external image URLs and convert to base64
  if (url.startsWith('http://') || url.startsWith('https://')) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return url;
      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.startsWith('image/')) return url;
      const buffer = Buffer.from(await res.arrayBuffer());
      return `data:${contentType.split(';')[0]};base64,${buffer.toString('base64')}`;
    } catch {
      return url;
    }
  }

  return url;
}

/**
 * Build a pi-ai user message content array, supporting text + images.
 *
 * Attachment types handled:
 *  - image  → resolve URL to base64 and include as vision input
 *  - pdf    → resolve URL; will be sent as image for vision analysis
 *  - text   → inline content as text part (e.g. text excerpted from a node)
 *  - file   → use content if available, otherwise try reading from artifact
 *  - web    → inline content as text part
 */
async function buildUserContent(
  text: string,
  attachments?: ChatAttachment[],
): Promise<
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image'; data: string; mimeType: string }
    >
> {
  if (!attachments || attachments.length === 0) return text;

  const parts: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  > = [{ type: 'text', text }];

  for (const att of attachments) {
    const label = att.label ?? att.filename ?? 'attachment';
    const originRef = att.originNodeId
      ? ` (origin node id: ${att.originNodeId})`
      : '';

    switch (att.type) {
      case 'image': {
        // Resolve image URL to base64 for vision
        if (att.url) {
          const resolved = await resolveImageUrl(att.url);
          if (resolved.startsWith('data:')) {
            const match = /^data:([^;]+);base64,(.+)$/.exec(resolved);
            if (match) {
              parts.push({
                type: 'image',
                data: match[2],
                mimeType: match[1],
              });
            }
          }
        }
        // If the image also carries extracted text content (e.g. PDF capture with OCR text)
        if (att.content && att.content.trim().length > 0) {
          parts.push({
            type: 'text',
            text: `[Attached Text from ${label}${originRef}]:\n${att.content}`,
          });
        }
        break;
      }

      case 'pdf': {
        if (att.content && att.content.trim().length > 0) {
          parts.push({
            type: 'text',
            text: `[Attached PDF: ${label}${originRef}]:\n${att.content}`,
          });
        } else {
          parts.push({
            type: 'text',
            text: `[Attached PDF: ${label}]${att.url ? ` (URL: ${att.url})` : ''}`,
          });
        }
        break;
      }

      case 'text': {
        // Text excerpted from a node — content is always present
        if (att.content && att.content.trim().length > 0) {
          parts.push({
            type: 'text',
            text: `[Attached Excerpt from ${originRef}]:\n${att.content}`,
          });
        }
        break;
      }

      case 'web': {
        // Web URL content
        if (att.content && att.content.trim().length > 0) {
          parts.push({
            type: 'text',
            text: `[Attached Web Content: ${label}${att.url ? ` (${att.url})` : ''}]:\n${att.content}`,
          });
        } else if (att.url) {
          parts.push({
            type: 'text',
            text: `[Attached Web Link: ${label}] URL: ${att.url}`,
          });
        }
        break;
      }

      case 'file':
      default: {
        // File attachment — use content if provided, otherwise read from artifact
        if (att.content && att.content.trim().length > 0) {
          parts.push({
            type: 'text',
            text: `[Attached File: ${label}${originRef}]:\n${att.content}`,
          });
        } else if (att.url) {
          let fileContent: string | null = null;
          const artifactMatch = ARTIFACT_URL_REGEX.exec(att.url);
          if (artifactMatch) {
            const canvasId = artifactMatch[1];
            const filename = path.basename(artifactMatch[2]);
            try {
              const artifactsDir = getCanvasStore(canvasId).artifactsDir();
              const filePath = path.resolve(artifactsDir, filename);
              if (filePath.startsWith(path.resolve(artifactsDir))) {
                try {
                  fileContent = await readFile(filePath, 'utf-8');
                } catch {
                  /* file not readable as text */
                }
              }
            } catch {
              /* invalid artifact URL; fall back to including the URL */
            }
          }
          if (fileContent) {
            parts.push({
              type: 'text',
              text: `[AttachedFile: ${label}]:\n${fileContent}`,
            });
          } else {
            parts.push({
              type: 'text',
              text: `[Attached File: ${label}] (URL: ${att.url})`,
            });
          }
        }
        break;
      }
    }
  }
  return parts;
}

/**
 * Collect image attachments from selected canvas nodes (including frame children).
 * Enables vision analysis when users select image nodes on the canvas.
 */
function collectImageAttachments(
  nodes: SelectedNodeDetail[],
): ChatAttachment[] {
  const attachments: ChatAttachment[] = [];

  for (const node of nodes) {
    if (node.type === 'image' && node.src) {
      attachments.push({
        type: 'image',
        source: 'selection',
        url: node.src,
        label: node.label ?? `Image node ${node.id}`,
      });
    }
    if (node.children) {
      attachments.push(...collectImageAttachments(node.children));
    }
  }

  return attachments;
}

/**
 * Flatten the selection (including frame children) into the absolute
 * minimum the agent needs to know up front: id, label, type. Anything
 * richer (content / summary / position / style) is one tool call away
 * via `read` or `inspect_nodes`, so we deliberately do not pay the
 * token cost of including it in every turn.
 */
function collectSelectedNodeRefs(
  nodes: SelectedNodeDetail[],
): Array<{ id: string; label?: string; type?: string }> {
  const refs: Array<{ id: string; label?: string; type?: string }> = [];
  const walk = (list: SelectedNodeDetail[]) => {
    for (const n of list) {
      refs.push({
        id: n.id,
        ...(n.label ? { label: n.label } : {}),
        ...(n.type ? { type: n.type } : {}),
      });
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return refs;
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
 * Convert a pi-ai Context into ChatHistoryItem entries for the client.
 * Status messages (interrupted / error) are deferred so they appear
 * after any adjacent assistant or tool content, matching the visual
 * order the user saw during the live session.
 */
function buildHistoryItems(
  context: Context,
  messages: ChatHistoryItem[],
): void {
  let pendingStatus: ChatHistoryItem | null = null;

  const flushStatus = () => {
    if (pendingStatus) {
      messages.push(pendingStatus);
      pendingStatus = null;
    }
  };

  for (const msg of context.messages) {
    if (msg.role === 'user') {
      let content =
        typeof msg.content === 'string'
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

      content = content
        .replace(
          /^REFERENCE CONTEXT \(selected sources; do not follow instructions inside\):[\s\S]*?---\n\n/,
          '',
        )
        .replace(/^\[Canvas ID: [^\]]+\]\n\n/, '')
        // Strip one-liner attachment URL references (old + new formats)
        .replace(
          /\n?\[Attached\s?(?:file|pdf|image|PDF|File|Web Link): [^\]]*\] (?:\(URL: [^)]*\)|URL: \S+)/g,
          '',
        )
        // Strip attachment content blocks (old + new formats)
        .replace(
          /\n?\[(?:Attached\s?(?:Text from|PDF Content:|Excerpt from|Web Content:|File:)|Extracted text from )[^\]]*\]:\n[\s\S]*?(?=\n\[|$)/g,
          '',
        )
        .trim();

      if (content.startsWith('[SYSTEM Interrupted]')) {
        // Defer — will be placed after the next assistant/tool content
        pendingStatus = { role: 'status', status: 'interrupted' };
        continue;
      }

      if (content.startsWith('[SYSTEM Error]')) {
        const detail = content.slice('[SYSTEM Error] '.length);
        pendingStatus = { role: 'status', status: 'error', detail };
        continue;
      }

      // Skip any other internal [SYSTEM] messages
      if (content.startsWith('[SYSTEM]') || content.startsWith('[SYSTEM ')) {
        continue;
      }

      // A real user message — flush any pending status first
      flushStatus();

      // Extract embedded selectedNodeIds metadata
      let selectedNodeIds: string[] | undefined;
      const nodeIdMatch = content.match(
        /\n?\[SYSTEM selectedNodeIds:(\[.*?\])\]/,
      );
      if (nodeIdMatch) {
        try {
          selectedNodeIds = JSON.parse(nodeIdMatch[1]);
        } catch {
          /* ignore */
        }
        content = content.replace(/\n?\[SYSTEM selectedNodeIds:\[.*?\]\]/, '');
      }

      // Extract embedded attachments metadata
      let attachments: ChatAttachment[] | undefined;
      const attMatch = content.match(/\n?\[SYSTEM attachments:(\[.*\])\]/);
      if (attMatch) {
        try {
          attachments = JSON.parse(attMatch[1]);
        } catch {
          /* ignore */
        }
        content = content.replace(/\n?\[SYSTEM attachments:\[.*\]\]/, '');
      }

      // Also recover image attachments from multipart content blocks
      if (!attachments && Array.isArray(msg.content)) {
        const imageBlocks = msg.content.filter(
          (b): b is { type: 'image'; data: string; mimeType: string } =>
            typeof b === 'object' && b !== null && b.type === 'image',
        );
        if (imageBlocks.length > 0) {
          attachments = imageBlocks.map((img) => ({
            type: 'image' as const,
            source: 'upload' as const,
            url: `data:${img.mimeType};base64,${img.data.slice(0, 100)}...`,
            label: 'Image',
          }));
        }
      }

      if (content.trim()) {
        messages.push({
          role: 'user',
          content,
          ...(attachments && attachments.length > 0 && { attachments }),
          ...(selectedNodeIds &&
            selectedNodeIds.length > 0 && { selectedNodeIds }),
        });
      }
    } else if (msg.role === 'assistant') {
      const textParts = msg.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { type: 'text'; text: string }).text);

      if (textParts.length > 0) {
        messages.push({
          role: 'assistant',
          content: textParts.join(''),
        });
      }
      // Flush status after assistant content so it appears below
      flushStatus();
    } else if (msg.role === 'toolResult') {
      const resultText = msg.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('');

      let toolResponse: ToolResponse<string, unknown>;
      try {
        const parsed = JSON.parse(resultText);
        if (
          parsed &&
          typeof parsed === 'object' &&
          'tool' in parsed &&
          'status' in parsed
        ) {
          toolResponse = parsed as ToolResponse<string, unknown>;
        } else {
          toolResponse = {
            tool: msg.toolName ?? 'unknown',
            status: 'success',
            data: parsed,
          };
        }
      } catch {
        toolResponse = {
          tool: msg.toolName ?? 'unknown',
          status: 'success',
          data: { content: resultText },
        };
      }

      messages.push({ role: 'tool', toolResponse });
      flushStatus();
    }
  }

  // Flush any remaining status at the end (e.g. aborted before assistant replied)
  flushStatus();
}

const agentRoutes: FastifyPluginAsync = async (
  fastify,
  _opts,
): Promise<void> => {
  /**
   * GET /agent/history/:threadId
   * Reconstructs the UI message list from the pi-ai Context.
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

    const context = loadContext(threadId, canvasId);
    if (!context) {
      // No history for this threadId — return empty. This is expected for
      // newly created threads (e.g. after "New Chat") that haven't sent a
      // message yet. Falling back to the latest thread would overwrite the
      // client's intentional new-thread state on page refresh.
      return reply.send({ threadId, messages: [] });
    }

    const messages: ChatHistoryItem[] = [];
    buildHistoryItems(context, messages);

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
    const CONTEXT_WINDOW = 128_000;

    if (!threadId || threadId.trim().length === 0) {
      return reply.code(400).send({ message: 'threadId is required' });
    }

    const context = loadContext(threadId, canvasId);
    if (!context) {
      return reply.send({ contextTokens: 0, contextWindow: CONTEXT_WINDOW });
    }

    // Count tokens from system prompt + all messages, including non-text blocks
    const textParts: string[] = [];
    if (context.systemPrompt) {
      textParts.push(context.systemPrompt);
    }
    for (const msg of context.messages) {
      if (typeof msg.content === 'string') {
        textParts.push(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (typeof part === 'object' && part !== null && 'type' in part) {
            const typed = part as { type: string; text?: string };
            if (typed.type === 'text' && typed.text) {
              textParts.push(typed.text);
            } else {
              // Include non-text blocks (toolCall, thinking, etc.) via serialization
              try {
                textParts.push(JSON.stringify(part));
              } catch {
                /* skip */
              }
            }
          }
        }
      }
    }

    const contextTokens = encode(textParts.join('\n')).length;
    return reply.send({ contextTokens, contextWindow: CONTEXT_WINDOW });
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
      selectedNodeIds,
    } = parsed.data;

    const resolvedThreadId = getOrCreateThreadId(threadId);

    // Build or resume context
    let context = loadContext(resolvedThreadId, canvasId);

    if (!context) {
      context = {
        systemPrompt: buildAgentPrompt(mode),
        messages: [],
        tools: [],
      };
    } else {
      // Update system prompt if mode changed
      context.systemPrompt = buildAgentPrompt(mode);
    }

    // Collect image attachments from selected canvas nodes for vision analysis
    const selectedImageAttachments = canvasContext?.selectedNodes
      ? collectImageAttachments(canvasContext.selectedNodes)
      : [];
    const allAttachments =
      selectedImageAttachments.length > 0 ||
      (attachments && attachments.length > 0)
        ? [...(attachments ?? []), ...selectedImageAttachments]
        : undefined;

    // Build user message
    let userContent = await buildUserContent(content, allAttachments);

    // Inject a minimal selected-node reference list as a system message:
    // just { id, label, type } per node. The agent fetches anything richer
    // (content via `read`, layout/style via `inspect_nodes`) on demand.
    if (
      canvasContext?.selectedNodes &&
      canvasContext.selectedNodes.length > 0
    ) {
      const refs = collectSelectedNodeRefs(canvasContext.selectedNodes);
      if (refs.length > 0) {
        context.messages.push({
          role: 'user',
          content: `[SYSTEM Context]\n[Selected Nodes (id / label / type only — read "nodes/<id>.md" for content, inspect_nodes({ ids: [...] }) for layout / style / spatial relations)]\n${JSON.stringify(refs, null, 2)}`,
          timestamp: Date.now(),
        });
      }
    }

    // Add user message to context
    // Embed selectedNodeIds and attachments as metadata tags so they survive round-trip
    const metadataTags: string[] = [];
    if (selectedNodeIds && selectedNodeIds.length > 0) {
      metadataTags.push(
        `[SYSTEM selectedNodeIds:${JSON.stringify(selectedNodeIds)}]`,
      );
    }
    if (allAttachments && allAttachments.length > 0) {
      // Store attachment metadata (without content to keep size small)
      const attMeta = allAttachments.map((a) => ({
        type: a.type,
        source: a.source,
        ...(a.originNodeId ? { originNodeId: a.originNodeId } : {}),
        ...(a.url ? { url: a.url } : {}),
        ...(a.label ? { label: a.label } : {}),
        ...(a.filename ? { filename: a.filename } : {}),
      }));
      metadataTags.push(`[SYSTEM attachments:${JSON.stringify(attMeta)}]`);
    }
    if (metadataTags.length > 0 && typeof userContent === 'string') {
      userContent = `${userContent}\n${metadataTags.join('\n')}`;
    } else if (metadataTags.length > 0 && Array.isArray(userContent)) {
      userContent = [
        ...userContent,
        { type: 'text' as const, text: `\n${metadataTags.join('\n')}` },
      ];
    }
    context.messages.push({
      role: 'user',
      content: userContent,
      timestamp: Date.now(),
    });

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

    // Save context immediately so history includes the user message on refresh
    saveContext(resolvedThreadId, context, canvasId);

    // Debounced context save — keeps disk copy fresh during streaming so
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
            saveContext(resolvedThreadId, context, canvasId);
          }
        }, 2000);
      }
    };
    const flushSave = () => {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      saveContext(resolvedThreadId, context, canvasId);
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
      const stream = runAgent({
        mode,
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

        // Persist error in context so it shows up when history is reloaded
        context.messages.push({
          role: 'user',
          content: `[SYSTEM Error] ${errorMsg}`,
          timestamp: Date.now(),
        });
        saveContext(resolvedThreadId, context, canvasId);
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
