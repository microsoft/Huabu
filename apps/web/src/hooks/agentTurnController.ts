// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  createId,
  variantForInternalTool,
  type AssistantToolPart,
  type AssistantToolVariant,
  type ImageGenerationData,
  type SnapshotNodesData,
  type ToolResponse,
  type WebSearchToolResponse,
} from '@huabu/shared';

import { ApiError } from '@/api/_client';
import { agentApi, type AgentStreamCallbacks } from '@/api/agent';
import { useAcpThreadChangesStore } from '@/store/acpThreadChangesStore';
import useCanvasStore, {
  saveCanvasForSubmission,
  type AgentSourceSelection,
} from '@/store/canvasStore';
import {
  selectThreadBinding,
  selectThreadIsLoading,
  selectThreadMessages,
  selectThreadSettings,
  useChatStore,
} from '@/store/chatStore';
import {
  awaitConversationDraft,
  conversationRequestScope,
  ConversationIntegrityError,
  resolveConversationAgentBinding,
  resolveConversationOwnerSource,
  shouldComposeConversationOwner,
  validateConversationView,
} from '@/store/conversationOwner';
import {
  invalidateConversationTitle,
  refreshConversationTitleAfterStream,
} from '@/store/conversationTitleStore';
import { useGesturePreviewStore } from '@/store/gesturePreviewStore';
import { isPageUnloading } from '@/utils/pageLifecycle';

import {
  abortAgentStreamClaim,
  claimAgentStream,
} from './agentStreamCoordinator';

import type { AssistantSegment, ChatMessage } from '../store/chatTypes';
import type { ChatSession } from '@/hooks/useChatSession';
import type {
  AgentBinding,
  AgentChatContext,
  AgentMode,
  AgentRequest,
  AgentStreamEvent,
  ChatAttachment,
  VisibleCanvasGrounding,
  SelectedStrokeSubset,
} from '@huabu/shared';

// ==================== Pure Utility Functions ====================

/**
 * Parse a tool result string into a proper ToolResponse.
 *
 * The server already wraps every tool result in a
 * `{ tool, status, ... }` envelope (see
 * apps/server/src/modules/agent/agent.service.ts). We accept that
 * envelope verbatim, accept bare JSON values as `{ status: 'success',
 * data }`, and treat parse failures as an error envelope so a
 * malformed payload can never masquerade as a successful tool result
 * (which would mislead canvas-write style tools that downstream code
 * applies blind).
 */
function parseToolResponse(
  toolName: string,
  raw: string | undefined,
): ToolResponse<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      'tool' in parsed &&
      'status' in parsed
    ) {
      return parsed as ToolResponse<string, unknown>;
    }
    // Valid JSON but not the standard envelope — treat as a successful
    // result whose payload IS the parsed value.
    return { tool: toolName, status: 'success', data: parsed };
  } catch (err) {
    // Truncate the raw text in the error message to keep the chat
    // bubble readable; the full raw value is preserved on `data.raw`
    // for debugging.
    const preview = raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
    console.error(
      '[useAgentStream] tool result was not valid JSON',
      toolName,
      err,
    );
    return {
      tool: toolName,
      status: 'error',
      error: `Tool returned non-JSON output: ${preview}`,
      data: { raw },
    } as ToolResponse<string, unknown>;
  }
}

/**
 * Normalize an internal tool's success payload before it gets
 * shallow-merged with the call args on `data.data`.
 *
 * Most tools return an object payload that merges cleanly, but
 * `snapshot_nodes` returns a bare array (`SnapshotEntry[]`) — spreading
 * that into the args object would corrupt the merge with numeric keys.
 * Wrap it under `snapshots` so the rich renderer (`SnapshotNodesCard`)
 * can read a stable shape.
 */
function normalizeInternalToolResultData(
  toolName: string,
  data: unknown,
): Record<string, unknown> {
  if (toolName === 'snapshot_nodes' && Array.isArray(data)) {
    return { snapshots: data };
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return {};
}

// ==================== SSE Event Handler ====================

interface StreamEventContext {
  /**
   * The thread that owns this stream. Captured at send time; all
   * message reads / writes inside the SSE handler key off this explicit
   * session address, so events keep landing on the originating
   * thread even after the user navigates away.
   */
  threadId: string;
  assistantId: string;
  /** Only unbound chats mirror ACP title metadata; Questions use node labels. */
  titleCanvasId?: string;
}

/**
 * Subset of `AgentStreamEvent` the ACP session-meta sink consumes.
 * Kept structural (not imported from the hook file) so the sink stays
 * decoupled from this module's other concerns.
 */
export type AcpSessionMetaStreamEvent = Extract<
  AgentStreamEvent,
  {
    type:
      | 'session_mode_update'
      | 'config_options_update'
      | 'session_info_update'
      | 'session_usage_update';
  }
>;

type AcpSessionMetaSink = (event: AcpSessionMetaStreamEvent) => void;
const acpSessionMetaSinks = new Map<string, AcpSessionMetaSink>();
interface TurnAcceptanceSink {
  afterTurnStartSeq: number;
  accept: (accepted: AgentTurnAccepted) => void;
  reject: () => void;
}
const turnAcceptanceSinks = new Map<string, TurnAcceptanceSink>();
const latestAcceptanceSeqByThread = new Map<string, number>();
const hiddenInkIntentToolCalls = new Map<
  string,
  { messageId?: string; inferredIntent?: string }
>();

function hiddenToolKey(threadId: string, toolCallId: string): string {
  return `${threadId}\0${toolCallId}`;
}

function clearHiddenIntentCalls(threadId: string): void {
  const prefix = `${threadId}\0`;
  for (const key of hiddenInkIntentToolCalls.keys()) {
    if (key.startsWith(prefix)) hiddenInkIntentToolCalls.delete(key);
  }
}

export function parseInferredInkIntent(rawInput: unknown): string | undefined {
  if (!rawInput || typeof rawInput !== 'object') return undefined;
  const report = rawInput as Record<string, unknown>;
  if (report.status !== 'inferred' || typeof report.text !== 'string')
    return undefined;
  const text = report.text.trim();
  return text.length > 0 && text.length <= 120 && !/[\r\n]/.test(text)
    ? text
    : undefined;
}

function turnKey(canvasId: string, threadId: string): string {
  return `${canvasId}\0${threadId}`;
}

export function observeAgentTurnAcceptance(
  canvasId: string,
  accepted: AgentTurnAccepted,
): void {
  const key = turnKey(canvasId, accepted.threadId);
  const latestSeq = latestAcceptanceSeqByThread.get(key) ?? 0;
  if (accepted.turnStartSeq <= latestSeq) return;
  latestAcceptanceSeqByThread.set(key, accepted.turnStartSeq);
  const sink = turnAcceptanceSinks.get(key);
  if (!sink || accepted.turnStartSeq <= sink.afterTurnStartSeq) return;
  sink.accept(accepted);
  if (turnAcceptanceSinks.get(key) === sink) {
    turnAcceptanceSinks.delete(key);
  }
}

function rejectAgentTurnAcceptance(canvasId: string, threadId: string): void {
  const key = turnKey(canvasId, threadId);
  const sink = turnAcceptanceSinks.get(key);
  if (!sink) return;
  turnAcceptanceSinks.delete(key);
  try {
    sink.reject();
  } catch (error) {
    console.error('Agent acceptance rejection callback failed', error);
  }
}

export function resetAgentTurnAcceptanceObserversForTests(): void {
  turnAcceptanceSinks.clear();
  latestAcceptanceSeqByThread.clear();
}

export function registerAcpSessionMetaSink(
  threadId: string,
  sink: AcpSessionMetaSink,
): () => void {
  acpSessionMetaSinks.set(threadId, sink);
  return () => {
    if (acpSessionMetaSinks.get(threadId) === sink) {
      acpSessionMetaSinks.delete(threadId);
    }
  };
}

/**
 * Ensure an assistant message exists for `ctx.assistantId`. Used by
 * the tool-call / plan handlers which may fire before any text_delta.
 */
function ensureAssistantMessage(ctx: StreamEventContext): void {
  const state = useChatStore.getState();
  const list = selectThreadMessages(state, ctx.threadId);
  const existing = list.find((m) => m.id === ctx.assistantId);
  if (!existing) {
    state.addMessage(ctx.threadId, {
      id: ctx.assistantId,
      role: 'assistant',
      segments: [],
    });
  }
}

/**
 * Merge a tool_call / tool_call_update payload onto an existing tool
 * part, preserving the variant tag.
 *
 * The `variant` is fixed by the FIRST observation (the producer
 * always knows it): external ACP `tool_call` events arrive as
 * `generic`; internal-agent turns set `internalToolName` and the
 * variant is computed from it via {@link variantForInternalTool}.
 * Subsequent updates never change the variant — only enrich its
 * fields.
 */
function mergeToolPart(
  existing: AssistantToolPart | undefined,
  toolCallId: string,
  patch: {
    variant?: AssistantToolVariant;
    toolName?: string;
    title?: string;
    command?: string;
    toolKind?: AssistantToolPart['toolKind'];
    status?: AssistantToolPart['status'];
    locations?: AssistantToolPart['locations'];
    content?: AssistantToolPart['content'];
    rawOutput?: unknown;
    /** Variant-specific `data` envelope; caller is responsible for shape. */
    data?: ToolResponse<string, unknown>;
  },
): AssistantToolPart {
  const variant: AssistantToolVariant =
    patch.variant ?? existing?.variant ?? 'generic';

  // Shared ToolPartBase fields — identical assembly for every variant.
  const title = patch.title ?? existing?.title ?? toolCallId;
  const command = patch.command ?? existing?.command;
  const toolKind = patch.toolKind ?? existing?.toolKind;
  const status = patch.status ?? existing?.status;
  // Locations/content are append-only per ACP §session/update spec.
  const mergedLocations = [
    ...(existing?.locations ?? []),
    ...(patch.locations ?? []),
  ];
  const mergedContent = [
    ...(existing?.content ?? []),
    ...(patch.content ?? []),
  ];
  const rawOutput = patch.rawOutput ?? existing?.rawOutput;
  const permission = existing?.permission;

  const base = {
    kind: 'tool' as const,
    toolCallId,
    title,
    ...(command !== undefined ? { command } : {}),
    ...(toolKind !== undefined ? { toolKind } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(mergedLocations.length > 0 ? { locations: mergedLocations } : {}),
    ...(mergedContent.length > 0 ? { content: mergedContent } : {}),
    ...(rawOutput !== undefined ? { rawOutput } : {}),
    ...(permission !== undefined ? { permission } : {}),
  };

  switch (variant) {
    case 'agent_tool': {
      const toolName =
        patch.toolName ??
        (existing?.variant === 'agent_tool' ? existing.toolName : title);
      const data =
        patch.data ??
        (existing?.variant === 'agent_tool' ? existing.data : undefined);
      return {
        ...base,
        variant: 'agent_tool',
        toolName,
        ...(data ? { data } : {}),
      };
    }
    case 'space_commands': {
      const data = (patch.data ??
        (existing?.variant === 'space_commands'
          ? existing.data
          : undefined)) as
        | ToolResponse<'space_commands', Record<string, unknown>>
        | undefined;
      return {
        ...base,
        variant: 'space_commands',
        ...(data ? { data } : {}),
      };
    }
    case 'web_search': {
      const data = (patch.data ??
        (existing?.variant === 'web_search' ? existing.data : undefined)) as
        | WebSearchToolResponse
        | undefined;
      return {
        ...base,
        variant: 'web_search',
        ...(data ? { data } : {}),
      };
    }
    case 'image_generation': {
      const data = (patch.data ??
        (existing?.variant === 'image_generation'
          ? existing.data
          : undefined)) as
        | ToolResponse<'generate_image', ImageGenerationData>
        | undefined;
      return {
        ...base,
        variant: 'image_generation',
        ...(data ? { data } : {}),
      };
    }
    case 'snapshot_nodes': {
      const data = (patch.data ??
        (existing?.variant === 'snapshot_nodes'
          ? existing.data
          : undefined)) as
        | ToolResponse<'snapshot_nodes', SnapshotNodesData>
        | undefined;
      return {
        ...base,
        variant: 'snapshot_nodes',
        ...(data ? { data } : {}),
      };
    }
    case 'generic':
      return { ...base, variant: 'generic' };
  }
}

/**
 * Fold an internal pi-ai tool *invocation* into the owning assistant
 * message: resolve its render variant from the tool name and stash a
 * provisional `ToolResponse` (the call args) so rich renderers have
 * something to show while the call is in flight. The eventual result
 * (via {@link applyInternalToolResult}) replaces the provisional data.
 *
 * Driven by the ACP-shaped `tool_call` event carrying an
 * `internalToolName`.
 */
function applyInternalToolStart(
  ctx: StreamEventContext,
  toolCallId: string,
  toolName: string,
  args: unknown,
): void {
  const { upsertAssistantToolPart } = useChatStore.getState();
  const variant = variantForInternalTool(toolName);
  const canonicalToolName =
    variant === 'space_commands' ? 'space_commands' : toolName;
  const provisional: ToolResponse<string, unknown> = {
    tool: canonicalToolName,
    status: 'success',
    data: args,
  };
  ensureAssistantMessage(ctx);
  upsertAssistantToolPart(
    ctx.threadId,
    ctx.assistantId,
    toolCallId,
    (existing) =>
      mergeToolPart(existing, toolCallId, {
        variant,
        toolName,
        title: toolName,
        status: 'pending',
        data: provisional,
      }),
  );
}

/**
 * Fold an internal pi-ai tool *result* into the owning assistant
 * message: parse the `ToolResponse` envelope, merge it over the
 * provisional args recorded by {@link applyInternalToolStart}, and
 * mark the part completed. Space state (for `space_commands`) is
 * applied separately via the sync broadcast, not here.
 *
 * Driven by the ACP-shaped `tool_call_update` event for an internal
 * tool. `rawText` is the JSON-stringified tool result payload.
 */
function applyInternalToolResult(
  ctx: StreamEventContext,
  toolCallId: string,
  toolName: string,
  rawText: string,
): void {
  const { upsertAssistantToolPart } = useChatStore.getState();
  const toolResponse = parseToolResponse(toolName, rawText);
  if (!toolResponse) return;

  const variant = variantForInternalTool(toolName);
  const assistantMsg = selectThreadMessages(
    useChatStore.getState(),
    ctx.threadId,
  ).find((m) => m.id === ctx.assistantId);
  let existingArgs: Record<string, unknown> = {};
  if (assistantMsg?.role === 'assistant') {
    const priorPart = assistantMsg.segments.find(
      (s): s is AssistantToolPart =>
        s.kind === 'tool' && s.toolCallId === toolCallId,
    );
    // Every rich variant carries the same `ToolResponse<…>`
    // envelope on `data`; only `generic` skips it. Reading via
    // the variant narrowing keeps the code honest — no cast.
    const priorData =
      priorPart && priorPart.variant !== 'generic' ? priorPart.data : undefined;
    if (priorData && priorData.status === 'success') {
      existingArgs =
        (priorData.data as Record<string, unknown> | undefined) ?? {};
    }
  }
  const mergedResponse: ToolResponse<string, unknown> = {
    ...toolResponse,
    tool: variant === 'space_commands' ? 'space_commands' : toolResponse.tool,
    data: {
      ...existingArgs,
      ...(toolResponse.status === 'success'
        ? normalizeInternalToolResultData(toolName, toolResponse.data)
        : {}),
    },
  } as ToolResponse<string, unknown>;

  ensureAssistantMessage(ctx);
  upsertAssistantToolPart(
    ctx.threadId,
    ctx.assistantId,
    toolCallId,
    (existing) =>
      mergeToolPart(existing, toolCallId, {
        variant,
        toolName,
        title: existing?.title ?? toolName,
        status: 'completed',
        data: mergedResponse,
      }),
  );
}

/**
 * Shared SSE event handler used by both reconnect and normal streaming.
 * Processes text_delta / thinking_delta / tool_call / tool_call_update /
 * plan, by updating chat messages and executing canvas commands.
 */
export function handleStreamEvent(
  event: AgentStreamEvent,
  ctx: StreamEventContext,
): void {
  const state = useChatStore.getState();
  const { addMessage, updateMessage, upsertAssistantToolPart } = state;
  // All reads / writes below key off the owner thread captured on
  // `ctx`, never the currently-visible thread. This is what makes
  // mid-stream thread switches safe — events keep landing on the
  // thread that issued the request.
  const ownerMessages = selectThreadMessages(state, ctx.threadId);

  if (event.type === 'done') {
    state.markTurnCompleted(ctx.threadId, ctx.assistantId);
  } else if (event.type === 'text_delta' || event.type === 'thinking_delta') {
    const delta = event.data.content;
    if (!delta) return;
    const kind: AssistantSegment['kind'] =
      event.type === 'text_delta' ? 'text' : 'thinking';
    const existing = ownerMessages.find((m) => m.id === ctx.assistantId);
    if (existing) {
      updateMessage(ctx.threadId, ctx.assistantId, (m) => {
        if (m.role !== 'assistant') return m;
        const segs = m.segments;
        const last = segs[segs.length - 1];
        // Same kind as trailing segment → extend in place. Different
        // kind (or empty) → push a new segment so time order survives
        // think/text/think interleaving from extended-thinking models.
        if (last && last.kind === kind) {
          return {
            ...m,
            segments: [
              ...segs.slice(0, -1),
              { ...last, text: last.text + delta },
            ],
          };
        }
        return { ...m, segments: [...segs, { kind, text: delta }] };
      });
    } else {
      addMessage(ctx.threadId, {
        id: ctx.assistantId,
        role: 'assistant',
        segments: [{ kind, text: delta }],
      });
    }
  } else if (event.type === 'tool_call') {
    const data = event.data;
    if (data.internalToolName === 'report_ink_intent') {
      const inferredIntent = parseInferredInkIntent(data.rawInput);
      const inkMessage = [...ownerMessages]
        .reverse()
        .find(
          (message) =>
            message.role === 'user' && message.inputKind === 'ink-intent',
        );
      hiddenInkIntentToolCalls.set(
        hiddenToolKey(ctx.threadId, data.toolCallId),
        {
          ...(inkMessage ? { messageId: inkMessage.id } : {}),
          ...(inferredIntent ? { inferredIntent } : {}),
        },
      );
      return;
    }
    // Internal pi-ai tools carry `internalToolName` → resolve the rich
    // variant + stash provisional args. External ACP tools leave it
    // undefined → render as `generic` from ACP-spec fields only.
    if (data.internalToolName) {
      applyInternalToolStart(
        ctx,
        data.toolCallId,
        data.internalToolName,
        data.rawInput,
      );
    } else {
      ensureAssistantMessage(ctx);
      upsertAssistantToolPart(
        ctx.threadId,
        ctx.assistantId,
        data.toolCallId,
        (existing) =>
          mergeToolPart(existing, data.toolCallId, {
            // ACP `tool_call` events always materialise as `generic`;
            // the wire shape carries only ACP-spec fields.
            variant: 'generic',
            title: data.title,
            command: data.command,
            toolKind: data.toolKind,
            status: data.status,
            locations: data.locations,
            content: data.content,
          }),
      );
    }
  } else if (event.type === 'tool_call_update') {
    const data = event.data;
    const hiddenKey = hiddenToolKey(ctx.threadId, data.toolCallId);
    const hiddenIntent = hiddenInkIntentToolCalls.get(hiddenKey);
    if (hiddenIntent) {
      if (
        data.status === 'completed' &&
        hiddenIntent.messageId &&
        hiddenIntent.inferredIntent
      ) {
        updateMessage(ctx.threadId, hiddenIntent.messageId, (message) =>
          message.role === 'user' && !message.inferredIntent
            ? { ...message, inferredIntent: hiddenIntent.inferredIntent }
            : message,
        );
      }
      if (
        data.rawOutput !== undefined ||
        data.status === 'completed' ||
        data.status === 'failed'
      ) {
        hiddenInkIntentToolCalls.delete(hiddenKey);
      }
      return;
    }
    ensureAssistantMessage(ctx);
    // An internal tool's completion arrives as a `tool_call_update`
    // carrying `rawOutput` (the JSON-stringified `ToolResponse`). The
    // update event itself has no tool name — recover it from the part
    // the originating `tool_call` already created (variant fixes it).
    const assistantMsg = ownerMessages.find((m) => m.id === ctx.assistantId);
    const priorPart =
      assistantMsg?.role === 'assistant'
        ? assistantMsg.segments.find(
            (s): s is AssistantToolPart =>
              s.kind === 'tool' && s.toolCallId === data.toolCallId,
          )
        : undefined;
    const internalToolName =
      priorPart?.variant === 'agent_tool'
        ? priorPart.toolName
        : priorPart?.variant === 'space_commands'
          ? 'space_commands'
          : priorPart?.variant === 'web_search'
            ? priorPart.variant
            : priorPart?.variant === 'image_generation'
              ? 'generate_image'
              : priorPart?.variant === 'snapshot_nodes'
                ? 'snapshot_nodes'
                : undefined;

    if (internalToolName && data.rawOutput !== undefined) {
      const rawText =
        typeof data.rawOutput === 'string'
          ? data.rawOutput
          : JSON.stringify(data.rawOutput);
      applyInternalToolResult(ctx, data.toolCallId, internalToolName, rawText);
    } else {
      upsertAssistantToolPart(
        ctx.threadId,
        ctx.assistantId,
        data.toolCallId,
        (existing) =>
          mergeToolPart(existing, data.toolCallId, {
            title: data.title,
            status: data.status,
            locations: data.locations,
            content: data.content,
            rawOutput: data.rawOutput,
          }),
      );
    }
  } else if (event.type === 'plan') {
    const entries = event.data.entries;
    ensureAssistantMessage(ctx);
    updateMessage(ctx.threadId, ctx.assistantId, (m) => {
      if (m.role !== 'assistant') return m;
      // Plan uses REPLACE-semantics per ACP §session/update.
      const planIdx = m.segments.findIndex((s) => s.kind === 'plan');
      if (planIdx === -1) {
        return { ...m, segments: [...m.segments, { kind: 'plan', entries }] };
      }
      const next = [...m.segments];
      next[planIdx] = { kind: 'plan', entries };
      return { ...m, segments: next };
    });
  } else if (event.type === 'permission_request') {
    const { requestId, toolCall, options } = event.data;
    ensureAssistantMessage(ctx);
    updateMessage(ctx.threadId, ctx.assistantId, (m) => {
      if (m.role !== 'assistant') return m;
      // Idempotent on reconnect: the SSE event buffer replays the
      // request, so de-dupe by requestId rather than appending twice.
      const existingIdx = m.segments.findIndex(
        (s) => s.kind === 'permission' && s.requestId === requestId,
      );
      if (existingIdx !== -1) return m;
      return {
        ...m,
        segments: [
          ...m.segments,
          { kind: 'permission', requestId, toolCall, options },
        ],
      };
    });
  } else if (
    event.type === 'session_mode_update' ||
    event.type === 'config_options_update' ||
    event.type === 'session_info_update' ||
    event.type === 'session_usage_update'
  ) {
    // Session-meta updates have no message-list impact — they drive
    // the owning ChatPanel's mode/model/config selector dropdowns. If
    // that thread has no mounted panel (e.g. headless reconnect), drop.
    acpSessionMetaSinks.get(ctx.threadId)?.(event);
    if (
      event.type === 'session_info_update' &&
      event.data.title !== undefined &&
      ctx.titleCanvasId
    ) {
      invalidateConversationTitle(ctx.titleCanvasId, ctx.threadId);
    }
  }
}

// ==================== Hook ====================

export interface CapturedAgentTurnSources {
  canvasId: string;
  canvasContext: AgentChatContext;
}

export interface AgentTurnInput {
  session: ChatSession;
  inputKind: NonNullable<AgentRequest['inputKind']>;
  content: string;
  mode: AgentMode;
  sources: CapturedAgentTurnSources;
  attachments?: ChatAttachment[];
  groundingVisual?: VisibleCanvasGrounding;
  invokedSkills?: string[];
}

export interface PreparedAgentTurn extends AgentTurnInput {
  agentBinding: AgentBinding;
  settings: { modelId: string | null; reasoningEffort: string | null };
}

export type AgentTurnAccepted = Parameters<
  NonNullable<AgentStreamCallbacks['onAccepted']>
>[0];

export interface AgentTurnCallbacks {
  canDispatch?: () => boolean;
  onStarted?: () => void;
  onAccepted?: (accepted: AgentTurnAccepted) => void;
  onAcceptanceRejected?: () => void;
}

export interface AgentTurnResult {
  status: 'completed' | 'failed' | 'stopped' | 'rejected' | 'unknown' | 'busy';
  accepted?: AgentTurnAccepted;
  error?: Error;
}

export function captureAgentTurnSources(
  session: ChatSession,
  selection?: AgentSourceSelection,
): CapturedAgentTurnSources {
  const scope = conversationRequestScope(
    session.conversationView,
    session.ownerCanvasId,
  );
  const canvas = useCanvasStore.getState();
  if (!scope.includeCanvasSelection) {
    return { canvasId: scope.canvasId, canvasContext: { selectedNodes: [] } };
  }
  if (canvas.canvasId !== scope.canvasId) {
    throw new ConversationIntegrityError('Source Canvas is no longer active');
  }
  const captured = selection ?? {
    nodeIds: canvas.nodes
      .filter((node) => node.selected)
      .map((node) => node.id),
    strokeSelection: useGesturePreviewStore.getState().sketchStrokeSelection,
  };
  return {
    canvasId: scope.canvasId,
    canvasContext: canvas.getAgentChatContext({
      ...captured,
      excludeNodeIds: [
        ...(captured.excludeNodeIds ?? []),
        ...(scope.anchorNodeId ? [scope.anchorNodeId] : []),
      ],
    }),
  };
}

export function prepareAgentTurn(input: AgentTurnInput): PreparedAgentTurn {
  const canvas = useCanvasStore.getState();
  const source = resolveConversationOwnerSource(
    canvas.canvasId,
    canvas.nodes,
    input.session.conversationView,
  );
  const chat = useChatStore.getState();
  return structuredClone({
    ...input,
    mode: source?.agentMode ?? input.mode,
    agentBinding: resolveConversationAgentBinding(
      source,
      selectThreadBinding(chat, input.session.threadId),
    ),
    settings: selectThreadSettings(chat, input.session.threadId),
  });
}

export function prepareAgentTurnRetry(
  session: ChatSession,
  message: Extract<ChatMessage, { role: 'user' }>,
  mode: AgentMode,
): PreparedAgentTurn {
  const sources = captureAgentTurnSources(session, {
    nodeIds: message.selectedNodeIds ?? [],
    strokeSelection: Object.fromEntries(
      (message.selectedStrokeIds ?? []).map((subset) => [
        subset.nodeId,
        subset.strokeIds,
      ]),
    ),
  });
  const present = new Set(
    sourceMessageMetadata(sources.canvasContext).selectedNodeIds,
  );
  if ((message.selectedNodeIds ?? []).some((nodeId) => !present.has(nodeId))) {
    throw new ConversationIntegrityError(
      'An original retry source is no longer available',
    );
  }
  const presentStrokeIds = new Map(
    sourceMessageMetadata(sources.canvasContext).selectedStrokeIds.map(
      (subset) => [subset.nodeId, new Set(subset.strokeIds)],
    ),
  );
  if (
    (message.selectedStrokeIds ?? []).some((subset) => {
      const strokes = presentStrokeIds.get(subset.nodeId);
      return (
        !strokes || subset.strokeIds.some((strokeId) => !strokes.has(strokeId))
      );
    })
  ) {
    throw new ConversationIntegrityError(
      'An original Ink retry source is no longer available',
    );
  }
  return prepareAgentTurn({
    session,
    mode,
    sources,
    content: message.content,
    inputKind: message.inputKind ?? 'text',
    attachments: message.attachments,
    invokedSkills: message.invokedSkills,
    groundingVisual: message.groundingVisual,
  });
}

function sourceMessageMetadata(context: AgentChatContext): {
  selectedNodeIds: string[];
  selectedStrokeIds: SelectedStrokeSubset[];
} {
  const selectedStrokeIds = new Map<string, SelectedStrokeSubset>();
  const visit = (nodes: AgentChatContext['selectedNodes']) => {
    for (const node of nodes) {
      if (node.strokeIds?.length)
        selectedStrokeIds.set(node.id, {
          nodeId: node.id,
          strokeIds: [...node.strokeIds],
        });
      if (node.children) visit(node.children);
    }
  };
  visit(context.selectedNodes);
  return {
    selectedNodeIds: context.selectedNodes.map((node) => node.id),
    selectedStrokeIds: [...selectedStrokeIds.values()],
  };
}

export async function dispatchAgentTurn(
  input: PreparedAgentTurn,
  callbacks: AgentTurnCallbacks = {},
): Promise<AgentTurnResult> {
  const prepared = structuredClone(input);
  const {
    session,
    content: prompt,
    mode: agentMode,
    invokedSkills,
    attachments,
    inputKind,
  } = prepared;
  const { threadId, conversationView } = session;
  const { addMessage, setThreadLastAction, setThreadLoading } =
    useChatStore.getState();
  const result: AgentTurnResult = { status: 'rejected' };
  const run = async (): Promise<void> => {
    // Per-thread guard: this thread's own loading flag, not any other
    // thread's. The user may already have a stream running in a
    // different chat (canvas chat + question node both active).
    if (
      (inputKind === 'text' && !prompt.trim()) ||
      selectThreadIsLoading(useChatStore.getState(), threadId)
    ) {
      result.status = selectThreadIsLoading(useChatStore.getState(), threadId)
        ? 'busy'
        : 'rejected';
      return;
    }

    // The anchored question node (when composing/replaying a question
    // thread) is the conversation's spatial anchor — the server already
    // injects its neighbourhood via `anchorNodeId`. Exclude it from the
    // selected-node context so the node isn't also attached to itself as
    // a "source".
    const requestScope = conversationRequestScope(
      conversationView,
      session.ownerCanvasId,
    );
    // Selected node ids are still recorded on the persisted user
    // message so the UI can re-render the selection chip after a
    // reload, even though we no longer derive any attachments from
    // them client-side. Include sketch nodes carrying a Stage-2
    // partial stroke selection (which live outside ReactFlow node
    // selection, in gesturePreviewStore) so the chip matches what was
    // actually sent as context.
    const canvasContext = prepared.sources.canvasContext;
    const {
      selectedNodeIds: sentSelectedNodeIds,
      selectedStrokeIds: sentSelectedStrokeIds,
    } = sourceMessageMetadata(canvasContext);
    const acceptanceKey = turnKey(requestScope.canvasId, threadId);
    if (turnAcceptanceSinks.has(acceptanceKey)) {
      result.status = 'busy';
      result.error = new Error(
        'The previous Agent turn is still awaiting acceptance reconciliation',
      );
      return;
    }
    const streamClaim = claimAgentStream(
      requestScope.canvasId,
      threadId,
      'post',
      { holdUntilRelease: true },
    );
    if (!streamClaim) {
      result.status = 'busy';
      return;
    }
    try {
      if (
        prepared.sources.canvasId !== requestScope.canvasId ||
        session.ownerCanvasId !== requestScope.canvasId ||
        (conversationView &&
          conversationView.conversationOwner.threadId !== threadId)
      ) {
        throw new ConversationIntegrityError(
          'Submission owner does not match its sources',
        );
      }
      if (inputKind === 'ink-intent' && sentSelectedStrokeIds.length === 0) {
        throw new Error('Ink requests require selected Sketch strokes');
      }
      if (conversationView) {
        await awaitConversationDraft(conversationView);
        await validateConversationView(conversationView);
      }
      if (streamClaim.signal.aborted) {
        result.status = 'stopped';
        return;
      }
      if (callbacks.canDispatch?.() === false) return;
      if (requestScope.includeCanvasSelection && requestScope.canvasId) {
        await saveCanvasForSubmission(requestScope.canvasId);
      }
      if (streamClaim.signal.aborted) {
        result.status = 'stopped';
        return;
      }
      if (callbacks.canDispatch?.() === false) return;
    } catch (error) {
      result.error = error instanceof Error ? error : new Error(String(error));
      addMessage(threadId, {
        id: createId('status'),
        role: 'status',
        status: 'error',
        detail: result.error.message,
      });
      return;
    } finally {
      if (
        result.error ||
        streamClaim.signal.aborted ||
        callbacks.canDispatch?.() === false
      )
        streamClaim.release();
    }
    setThreadLastAction(threadId, agentMode);
    callbacks.onStarted?.();

    addMessage(threadId, {
      id: createId('message'),
      role: 'user',
      content: prompt,
      inputKind,
      groundingVisual: prepared.groundingVisual,
      attachments,
      ...(sentSelectedNodeIds.length > 0
        ? { selectedNodeIds: sentSelectedNodeIds }
        : {}),
      ...(sentSelectedStrokeIds.length > 0
        ? { selectedStrokeIds: sentSelectedStrokeIds }
        : {}),
      ...(invokedSkills && invokedSkills.length > 0 ? { invokedSkills } : {}),
    });

    setThreadLoading(threadId, true);

    const assistantId = createId('message');

    // Guard: ensure only one of onError / catch adds an error status
    let errorHandled = false;

    const releaseAbort = () => {
      streamClaim.release();
    };

    // Canvas Sync owns all Question lifecycle projection. This controller
    // maintains request feedback, durable acceptance, and the transcript.
    let serverSettingsConfirmed = false;
    let titleCreationConfirmed = false;
    const canvasState = useCanvasStore.getState();
    const ownerSource = conversationView
      ? resolveConversationOwnerSource(
          canvasState.canvasId,
          canvasState.nodes,
          conversationView,
        )
      : undefined;
    const isComposingQuestion =
      !!conversationView && shouldComposeConversationOwner(ownerSource);
    const refreshAfterLifecycle = async () => {
      if (!conversationView) return;
      await useAcpThreadChangesStore
        .getState()
        .load(
          conversationView.conversationOwner.canvasId,
          conversationView.conversationOwner.threadId,
        );
    };

    const acceptTurn = (accepted: AgentTurnAccepted) => {
      if (result.accepted) return;
      result.accepted = accepted;
      if (isComposingQuestion && !serverSettingsConfirmed) {
        serverSettingsConfirmed = true;
        useChatStore.getState().makeThreadMetadataEphemeral(threadId);
      }
      try {
        callbacks.onAccepted?.(accepted);
      } catch (error) {
        console.error('Agent acceptance callback failed', error);
      }
    };
    const acceptanceSink: TurnAcceptanceSink = {
      afterTurnStartSeq: latestAcceptanceSeqByThread.get(acceptanceKey) ?? 0,
      accept: acceptTurn,
      reject: () => callbacks.onAcceptanceRejected?.(),
    };
    turnAcceptanceSinks.set(acceptanceKey, acceptanceSink);
    // Make sure any buffered behavioural events have hit the server
    // before the agent builds its request context. Failures are
    // swallowed inside the flush helper — we never want a transient
    // network blip to block the agent call.
    try {
      if (requestScope.includeCanvasSelection && requestScope.canvasId) {
        await useCanvasStore.getState().flushCanvasEvents();
      }
      if (streamClaim.signal.aborted) {
        result.status = 'stopped';
        return;
      }

      // Snapshot the current thread's picker binding at send time. The server
      // uses it for selectable threads but replaces it with the persisted
      // binding when the thread resolves to a fixed Agent Node.
      const agentBinding = resolveConversationAgentBinding(
        ownerSource,
        prepared.agentBinding,
      );

      // Build the canvas context, dropping the anchored question node
      // from `selectedNodes` for the same reason as `selectedNodeIds`
      // above — it is the conversation anchor, not a separate source.
      result.status = 'unknown';
      await agentApi.streamMessage(
        prompt,
        threadId,
        agentMode,
        {
          onAccepted: (accepted) => {
            observeAgentTurnAcceptance(requestScope.canvasId, accepted);
          },
          onEvent: (event: AgentStreamEvent) => {
            if (streamClaim.signal.aborted) return;
            if (!conversationView && !titleCreationConfirmed) {
              titleCreationConfirmed = true;
              refreshConversationTitleAfterStream(
                session.ownerCanvasId,
                threadId,
              );
            }
            handleStreamEvent(event, {
              threadId,
              assistantId,
              titleCanvasId: conversationView
                ? undefined
                : session.ownerCanvasId,
            });
          },
          onError: (err) => {
            if (isPageUnloading() || errorHandled || streamClaim.signal.aborted)
              return;
            errorHandled = true;
            result.error = err;
            result.status = result.accepted
              ? 'failed'
              : err instanceof ApiError && err.status < 500
                ? 'rejected'
                : 'unknown';
            console.error(`${agentMode} error:`, err);
            addMessage(threadId, {
              id: createId('status'),
              role: 'status',
              status: 'error',
              detail: err.message,
            });
          },
          onComplete: () => {
            if (errorHandled) return;
            result.status = streamClaim.signal.aborted
              ? 'stopped'
              : 'completed';
          },
        },
        {
          inputKind,
          groundingVisual: prepared.groundingVisual,
          canvasContext,
          canvasId: requestScope.canvasId || undefined,
          attachments,
          agentBinding,
          anchorNodeId: requestScope.anchorNodeId,
          invokedSkills,
          // Carry this thread's built-in selection so a model /
          // reasoning effort picked before the first message is applied
          // when the thread is created. Ignored server-side for external
          // bindings.
          modelId: prepared.settings.modelId ?? undefined,
          reasoningEffort: prepared.settings.reasoningEffort ?? undefined,
          signal: streamClaim.signal,
        },
      );
    } catch (err) {
      // Abort is not an error — stream was intentionally stopped.
      if (streamClaim.signal.aborted) {
        result.status = 'stopped';
        return;
      }
      // Page unloading — don't persist error
      if (isPageUnloading()) return;
      // Skip if onError callback already handled this
      if (errorHandled) return;
      errorHandled = true;
      result.error = err instanceof Error ? err : new Error(String(err));
      console.error(`${agentMode} failed:`, err);
      addMessage(threadId, {
        id: createId('status'),
        role: 'status',
        status: 'error',
        detail: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      try {
        if (!conversationView) {
          refreshConversationTitleAfterStream(session.ownerCanvasId, threadId);
        }
        await refreshAfterLifecycle();
      } catch (error) {
        console.error('Failed to refresh Agent turn presentation', error);
        result.error ??=
          error instanceof Error ? error : new Error(String(error));
      } finally {
        clearHiddenIntentCalls(threadId);
        const retainForReconciliation =
          result.status === 'unknown' && !result.accepted;
        if (
          !retainForReconciliation &&
          turnAcceptanceSinks.get(acceptanceKey) === acceptanceSink
        ) {
          turnAcceptanceSinks.delete(acceptanceKey);
        }
        setThreadLoading(threadId, false);
        releaseAbort();
      }
    }
  };
  await run();
  return result;
}

export function stopAgentTurn(session: ChatSession): void {
  const { threadId, ownerCanvasId, conversationView } = session;
  const { addMessage, updateMessage, setThreadLoading } =
    useChatStore.getState();
  // Stop this session's thread. Keep the local subscription and claim alive
  // until the server confirms the outcome: a transport failure is ambiguous
  // and the original stream is then the reconciliation channel.
  const tid = threadId;
  const scopedCanvasId = conversationRequestScope(
    conversationView,
    ownerCanvasId,
  ).canvasId;
  void agentApi
    .stopThread(tid, scopedCanvasId)
    .then((response) => {
      if (!response.stopped) return;
      if (response.acceptance) {
        observeAgentTurnAcceptance(scopedCanvasId, response.acceptance);
      } else {
        rejectAgentTurnAcceptance(scopedCanvasId, tid);
      }
      abortAgentStreamClaim(scopedCanvasId, tid);
      setThreadLoading(tid, false);

      addMessage(tid, {
        id: createId('status'),
        role: 'status',
        status: 'interrupted',
      });

      // Mark any still-pending tool parts as cancelled so the renderer
      // can drop spinners / show a definitive end state.
      const msgs = selectThreadMessages(useChatStore.getState(), tid);
      for (const msg of msgs) {
        if (msg.role !== 'assistant') continue;
        const hasInflight = msg.segments.some(
          (s) =>
            s.kind === 'tool' &&
            (s.status === 'pending' || s.status === 'in_progress'),
        );
        if (!hasInflight) continue;
        updateMessage(tid, msg.id, (m) => {
          if (m.role !== 'assistant') return m;
          return {
            ...m,
            segments: m.segments.map((s) => {
              if (s.kind !== 'tool') return s;
              if (s.status !== 'pending' && s.status !== 'in_progress')
                return s;
              return { ...s, status: 'failed' };
            }),
          };
        });
      }
    })
    .catch((error) => {
      console.error(
        `Failed to confirm stop for Agent thread ${tid}; continuing to monitor the active stream.`,
        error,
      );
    });
}
