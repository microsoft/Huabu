// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useCallback, useRef } from 'react';

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

import { agentApi } from '@/api/agent';
import { toast } from '@/components/Common/Toast';
import { isActivelyViewingQuestion } from '@/hooks/useActivelyViewingQuestion';
import { i18n } from '@/i18n';
import { useAcpProfilesStore } from '@/store/acpProfilesStore';
import { useAcpThreadChangesStore } from '@/store/acpThreadChangesStore';
import useCanvasStore from '@/store/canvasStore';
import {
  selectThreadBinding,
  selectThreadIsLoading,
  selectThreadMessages,
  selectThreadPendingAttachments,
  selectThreadSettings,
  useChatStore,
} from '@/store/chatStore';
import {
  conversationRequestScope,
  ConversationIntegrityError,
  filterClientOwnedQuestionPatch,
  isHeadlessConversation,
  patchConversationOwnerNode,
  refreshConversationPresentation,
  resolveConversationOwnerSource,
  shouldComposeConversationOwner,
  validateConversationView,
} from '@/store/conversationOwner';
import { useGesturePreviewStore } from '@/store/gesturePreviewStore';
import { usePreviewWorkspaceStore } from '@/store/previewWorkspace/store';
import { snapshotAgentIcon } from '@/utils/agentIcon';
import { isPageUnloading } from '@/utils/pageLifecycle';

import {
  abortAgentStreamClaim,
  claimAgentStream,
} from './agentStreamCoordinator';

import type { AssistantSegment } from '../store/chatTypes';
import type { ChatSession } from '@/hooks/useChatSession';
import type { AgentMode, AgentStreamEvent } from '@huabu/shared';

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

  if (event.type === 'text_delta' || event.type === 'thinking_delta') {
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
  }
}

// ==================== Hook ====================

export interface UseAgentStreamReturn {
  /** True if the *currently visible* thread has an active stream. */
  isLoading: boolean;
  /**
   * Mark a specific thread as loading. Exposed so `useChatHistory` can
   * flip the flag on/off during stream reconnection for whichever
   * thread it is attached to — callers must pass the owner thread
   * explicitly so reconnects on a backgrounded thread don't paint into
   * the currently-visible one.
   */
  setIsLoading: (threadId: string, loading: boolean) => void;
  /** Start a streaming agent request. */
  startStream: (
    prompt: string,
    agentMode: AgentMode,
    /**
     * Optional skill ids the user explicitly invoked via leading
     * `/<id>` tokens. Forwarded to the server, which prepends each
     * skill body as a SYSTEM preamble for the turn. See
     * `useInternalSlashCommands` / `parseSlashInvocations`.
     */
    invokedSkills?: string[],
  ) => Promise<void>;
  /** Stop the current stream. */
  stopStream: () => void;
}

/**
 * Hook that manages agent streaming, including starting/stopping streams
 * and processing SSE events.
 *
 * Every read and write is addressed to `session.threadId`, never to whichever
 * thread happens to be visible, so two mounted Chat renderers stream
 * independently.
 */
export function useAgentStream(
  session: ChatSession,
  previewTabId?: string,
): UseAgentStreamReturn {
  const { threadId, canvasId, conversationView } = session;
  // Loading is per-thread: a question node's thread can stream independently
  // of the canvas chat.
  const isLoading = useChatStore((state) =>
    selectThreadIsLoading(state, threadId),
  );
  const setThreadLoading = useChatStore((state) => state.setThreadLoading);

  const addMessage = useChatStore((state) => state.addMessage);
  const updateMessage = useChatStore((state) => state.updateMessage);
  const setThreadLastAction = useChatStore(
    (state) => state.setThreadLastAction,
  );
  const pendingAttachments = useChatStore((state) =>
    selectThreadPendingAttachments(state, threadId),
  );
  const selectionAttachment = useChatStore(
    (state) => state.selectionAttachment,
  );
  const clearPendingAttachments = useChatStore(
    (state) => state.clearPendingAttachments,
  );

  const getAgentChatContext = useCanvasStore(
    (state) => state.getAgentChatContext,
  );

  // Per-thread abort controllers. We can have multiple streams in
  // flight at once (canvas chat + one or more question threads), so a
  // single ref would clobber a still-running run when the next send
  // starts on a different thread.
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());

  const startStream = useCallback(
    async (prompt: string, agentMode: AgentMode, invokedSkills?: string[]) => {
      // Per-thread guard: this thread's own loading flag, not any other
      // thread's. The user may already have a stream running in a
      // different chat (canvas chat + question node both active).
      if (
        !prompt.trim() ||
        selectThreadIsLoading(useChatStore.getState(), threadId)
      )
        return;

      if (conversationView) {
        try {
          await validateConversationView(conversationView);
        } catch (error) {
          if (error instanceof ConversationIntegrityError) {
            toast(i18n.t('world.conversationIntegrityError'), {
              tone: 'danger',
            });
            return;
          }
          throw error;
        }
        // Validation is async, so confirm this renderer still owns the same
        // tab. Closing or replacing it invalidates the pending send.
        if (previewTabId) {
          const tab =
            usePreviewWorkspaceStore.getState().workspace.tabs[previewTabId];
          if (
            tab?.target.kind !== 'node' ||
            tab.target.canvasId !==
              conversationView.presentationAnchor.canvasId ||
            tab.target.nodeId !== conversationView.presentationAnchor.nodeId
          ) {
            return;
          }
        }
      }

      setThreadLastAction(threadId, agentMode);

      // Merge pending attachments + selection attachment into a single array.
      // Sketch-rasterization is now performed server-side in `agent.route.ts`
      // for any `sketch` nodes present in `canvasContext.selectedNodes`, so we
      // no longer build PNG attachments client-side.
      const allPending = [
        ...pendingAttachments,
        ...(selectionAttachment ? [selectionAttachment] : []),
      ];

      // The anchored question node (when composing/replaying a question
      // thread) is the conversation's spatial anchor — the server already
      // injects its neighbourhood via `anchorNodeId`. Exclude it from the
      // selected-node context so the node isn't also attached to itself as
      // a "source".
      const requestScope = conversationRequestScope(conversationView, canvasId);
      const anchorQuestionNodeId =
        conversationView?.conversationOwner.nodeId ?? null;
      const headless = isHeadlessConversation(conversationView);
      const refreshAfterLifecycle = async () => {
        if (!conversationView) return;
        await refreshConversationPresentation(conversationView);
        if (headless) {
          await useAcpThreadChangesStore
            .getState()
            .load(
              conversationView.conversationOwner.canvasId,
              conversationView.conversationOwner.threadId,
            );
        }
      };

      // Selected node ids are still recorded on the persisted user
      // message so the UI can re-render the selection chip after a
      // reload, even though we no longer derive any attachments from
      // them client-side. Include sketch nodes carrying a Stage-2
      // partial stroke selection (which live outside ReactFlow node
      // selection, in gesturePreviewStore) so the chip matches what was
      // actually sent as context.
      const nodeSelectedIds = useCanvasStore
        .getState()
        .nodes.filter((n) => n.selected && n.id !== anchorQuestionNodeId)
        .map((n) => n.id);
      const selectedStrokeIds = Object.entries(
        useGesturePreviewStore.getState().sketchStrokeSelection,
      )
        .filter(
          ([nodeId, strokeIds]) =>
            strokeIds.length > 0 && nodeId !== anchorQuestionNodeId,
        )
        .map(([nodeId, strokeIds]) => ({ nodeId, strokeIds }));
      const selectedNodeIds = Array.from(
        new Set([
          ...nodeSelectedIds,
          ...selectedStrokeIds.map((s) => s.nodeId),
        ]),
      );
      const sentSelectedNodeIds = requestScope.includeCanvasSelection
        ? selectedNodeIds
        : [];
      const sentSelectedStrokeIds = requestScope.includeCanvasSelection
        ? selectedStrokeIds
        : [];

      const mergedAttachments = [...allPending];
      const attachments =
        mergedAttachments.length > 0 ? mergedAttachments : undefined;
      const streamClaim = claimAgentStream(
        requestScope.canvasId,
        threadId,
        'post',
      );
      if (!streamClaim) return;

      // Both are consumed by the send, and they are cleared separately
      // because they are owned differently: staged attachments belong to this
      // thread, while the excerpt is the one shared selection. Spending it
      // here retires the hint from every Chat showing it, which is correct —
      // there is only ever one selection and this send just used it.
      if (pendingAttachments.length > 0) {
        clearPendingAttachments(threadId);
      }
      if (selectionAttachment) {
        useChatStore.getState().setSelectionAttachment(null);
      }

      addMessage(threadId, {
        id: createId('message'),
        role: 'user',
        content: prompt,
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

      // Create abort controller for this stream and register it under
      // the owning thread so `stopStream` can find it later.
      const abortController = new AbortController();
      abortControllersRef.current.set(threadId, abortController);
      // Snapshot the controller binding so we only clear our own entry
      // — a newer run on the same thread must not be cancelled by our
      // cleanup.
      const releaseAbort = () => {
        if (abortControllersRef.current.get(threadId) === abortController) {
          abortControllersRef.current.delete(threadId);
        }
        streamClaim.release();
      };

      // ── Question-node follow-up bookkeeping ─────────────────────────
      //
      // When this session renders a selectable Question Node, this hook keeps
      // its client-authored lifecycle honest across follow-up turns. Fixed
      // Agent Nodes route content/status/error through the server; this hook
      // writes only their client presentation state (`viewed`).
      //
      // We also track whether a successful `done` event was observed so
      // a late cap-out `error` event (`Agent loop exceeded maximum
      // iterations`) emitted *after* a complete answer doesn't flip the
      // node to `error` (issue 3 — tool failures during a successful
      // agent run should not poison the final status).
      const questionNodeId = conversationView?.conversationOwner.nodeId ?? null;
      let sawDone = false;
      let serverOwnsQuestionLifecycle = false;
      let isComposingQuestion = false;
      let serverSettingsConfirmed = false;

      if (questionNodeId && conversationView) {
        // First send of a freshly-composed question node ⇔ the node is still
        // `idle` (never authored/run). Derived from the node's own status so
        // there is no stored `compose` flag to keep in sync. On that first
        // send we author the node's `content` and lock in the agent the user
        // picked in the inline selector (binding + built-in mode); follow-up
        // turns skip both.
        const canvasState = useCanvasStore.getState();
        const ownerSource = resolveConversationOwnerSource(
          canvasState.canvasId,
          canvasState.nodes,
          canvasState.worldReferences,
          conversationView,
        );
        const isCompose = shouldComposeConversationOwner(ownerSource, headless);
        isComposingQuestion = isCompose;
        serverOwnsQuestionLifecycle =
          ownerSource?.agentBindingPolicy === 'fixed';
        if (isCompose && !headless && !serverOwnsQuestionLifecycle) {
          // Author content through the intent pipeline so it gets a
          // markdown sidecar save + server-side label preprocessing —
          // matching how the inline editor used to commit the prompt.
          useCanvasStore
            .getState()
            .updateNodeData(questionNodeId, { content: prompt });
        }
        const selectedBinding = selectThreadBinding(
          useChatStore.getState(),
          threadId,
        );
        const selectedProfile =
          selectedBinding.kind === 'external'
            ? useAcpProfilesStore
                .getState()
                .profiles.find(
                  (profile) => profile.id === selectedBinding.profileId,
                )
            : undefined;
        const snapshotBinding =
          selectedBinding.kind === 'external' && selectedProfile
            ? { ...selectedBinding, alias: selectedProfile.alias }
            : selectedBinding;
        const composeBinding =
          isCompose && !headless && !serverOwnsQuestionLifecycle
            ? {
                agentBinding: snapshotBinding,
                agentIcon: snapshotAgentIcon(
                  selectedBinding,
                  useAcpProfilesStore.getState().profiles,
                ),
                agentMode,
              }
            : {};
        // Reset `viewed` so the layer-panel dot + on-canvas "done · unread"
        // glow re-appear when the follow-up answer lands. Completion marks it
        // viewed again if the user is still in the thread.
        const startPatch = filterClientOwnedQuestionPatch(ownerSource, {
          ...(isCompose && headless ? { content: prompt } : {}),
          status: 'running',
          errorMessage: undefined,
          viewed: false,
          ...composeBinding,
        });
        try {
          if (startPatch) {
            await patchConversationOwnerNode(conversationView, startPatch);
            await refreshConversationPresentation(conversationView);
            if (isCompose) {
              useChatStore.getState().makeThreadMetadataEphemeral(threadId, {
                preserveSettings: true,
              });
            }
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Unknown error';
          setThreadLoading(threadId, false);
          releaseAbort();
          addMessage(threadId, {
            id: createId('status'),
            role: 'status',
            status: 'error',
            detail: message,
          });
          return;
        }
      }

      // Make sure any buffered behavioural events have hit the server
      // before the agent builds its request context. Failures are
      // swallowed inside the flush helper — we never want a transient
      // network blip to block the agent call.
      await useCanvasStore.getState().flushCanvasEvents();

      // Snapshot the current thread's picker binding at send time. The server
      // uses it for selectable threads but replaces it with the persisted
      // binding when the thread resolves to a fixed Agent Node.
      const agentBinding = selectThreadBinding(
        useChatStore.getState(),
        threadId,
      );

      // Build the canvas context, dropping the anchored question node
      // from `selectedNodes` for the same reason as `selectedNodeIds`
      // above — it is the conversation anchor, not a separate source.
      const baseCanvasContext = requestScope.includeCanvasSelection
        ? getAgentChatContext()
        : { selectedNodes: [] };
      const canvasContext =
        anchorQuestionNodeId && !headless
          ? {
              ...baseCanvasContext,
              selectedNodes: baseCanvasContext.selectedNodes.filter(
                (n) => n.id !== anchorQuestionNodeId,
              ),
            }
          : baseCanvasContext;

      try {
        await agentApi.streamMessage(
          prompt,
          threadId,
          agentMode,
          {
            onEvent: (event: AgentStreamEvent) => {
              if (isComposingQuestion && !serverSettingsConfirmed) {
                serverSettingsConfirmed = true;
                useChatStore.getState().makeThreadMetadataEphemeral(threadId);
              }
              if (event.type === 'done') sawDone = true;
              handleStreamEvent(event, {
                threadId,
                assistantId,
              });
            },
            onError: (err) => {
              if (isPageUnloading() || errorHandled) return;
              errorHandled = true;
              console.error(`${agentMode} error:`, err);
              // Question-node follow-up: only flip to `error` if no
              // useful final `done` event ever arrived. A cap-out error
              // emitted after a successful answer is treated as success.
              if (questionNodeId) {
                const stillViewing = isActivelyViewingQuestion({
                  nodeId: questionNodeId,
                });
                const terminalPatch = filterClientOwnedQuestionPatch(
                  serverOwnsQuestionLifecycle
                    ? { agentBindingPolicy: 'fixed' }
                    : undefined,
                  {
                    status: sawDone ? 'done' : 'error',
                    errorMessage: sawDone ? undefined : err.message,
                    ...(stillViewing ? { viewed: true } : {}),
                  },
                );
                if (conversationView && terminalPatch) {
                  void patchConversationOwnerNode(
                    conversationView,
                    terminalPatch,
                  )
                    .then(refreshAfterLifecycle)
                    .catch((error) =>
                      console.error(
                        '[useAgentStream] failed to persist owner error',
                        error,
                      ),
                    )
                    .finally(() => {
                      setThreadLoading(threadId, false);
                      releaseAbort();
                    });
                } else {
                  setThreadLoading(threadId, false);
                  releaseAbort();
                }
              } else {
                setThreadLoading(threadId, false);
                releaseAbort();
              }
              addMessage(threadId, {
                id: createId('status'),
                role: 'status',
                status: 'error',
                detail: err.message,
              });
            },
            onComplete: () => {
              if (questionNodeId) {
                // If the user is still actively viewing this question
                // thread at completion, count it as read — they watched
                // the answer stream. Otherwise leave `viewed: false` so
                // the layer-panel dot stays "unread" until they open it.
                const stillViewing = isActivelyViewingQuestion({
                  nodeId: questionNodeId,
                });
                const terminalPatch = filterClientOwnedQuestionPatch(
                  serverOwnsQuestionLifecycle
                    ? { agentBindingPolicy: 'fixed' }
                    : undefined,
                  {
                    status: 'done',
                    errorMessage: undefined,
                    ...(stillViewing ? { viewed: true } : {}),
                  },
                );
                if (conversationView && terminalPatch) {
                  void patchConversationOwnerNode(
                    conversationView,
                    terminalPatch,
                  )
                    .then(refreshAfterLifecycle)
                    .catch((error) =>
                      console.error(
                        '[useAgentStream] failed to persist owner completion',
                        error,
                      ),
                    )
                    .finally(() => {
                      setThreadLoading(threadId, false);
                      releaseAbort();
                    });
                } else {
                  setThreadLoading(threadId, false);
                  releaseAbort();
                }
              } else {
                setThreadLoading(threadId, false);
                releaseAbort();
              }
            },
          },
          {
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
            ...(() => {
              const settings = selectThreadSettings(
                useChatStore.getState(),
                threadId,
              );
              return {
                modelId: settings.modelId ?? undefined,
                reasoningEffort: settings.reasoningEffort ?? undefined,
              };
            })(),
            signal: AbortSignal.any([
              abortController.signal,
              streamClaim.signal,
            ]),
          },
        );
      } catch (err) {
        // Abort is not an error — stream was intentionally stopped.
        if (abortController.signal.aborted) {
          setThreadLoading(threadId, false);
          releaseAbort();
          if (questionNodeId) {
            // User stopped the stream while in the thread — count as
            // viewed; otherwise leave unread so the dot reappears.
            const stillViewing = isActivelyViewingQuestion({
              nodeId: questionNodeId,
            });
            if (conversationView) {
              const terminalPatch = filterClientOwnedQuestionPatch(
                serverOwnsQuestionLifecycle
                  ? { agentBindingPolicy: 'fixed' }
                  : undefined,
                {
                  status: 'done',
                  errorMessage: undefined,
                  ...(stillViewing ? { viewed: true } : {}),
                },
              );
              if (terminalPatch) {
                await patchConversationOwnerNode(
                  conversationView,
                  terminalPatch,
                );
                await refreshAfterLifecycle();
              }
            }
          }
          return;
        }
        // Page unloading — don't persist error
        if (isPageUnloading()) return;
        // Skip if onError callback already handled this
        if (errorHandled) return;
        errorHandled = true;
        console.error(`${agentMode} failed:`, err);
        if (questionNodeId) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          const stillViewing = isActivelyViewingQuestion({
            nodeId: questionNodeId,
          });
          if (conversationView) {
            const terminalPatch = filterClientOwnedQuestionPatch(
              serverOwnsQuestionLifecycle
                ? { agentBindingPolicy: 'fixed' }
                : undefined,
              {
                status: sawDone ? 'done' : 'error',
                errorMessage: sawDone ? undefined : message,
                ...(stillViewing ? { viewed: true } : {}),
              },
            );
            if (terminalPatch) {
              await patchConversationOwnerNode(conversationView, terminalPatch);
              await refreshAfterLifecycle();
            }
          }
        }
        setThreadLoading(threadId, false);
        releaseAbort();
        addMessage(threadId, {
          id: createId('status'),
          role: 'status',
          status: 'error',
          detail: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    },
    [
      pendingAttachments,
      selectionAttachment,
      clearPendingAttachments,
      addMessage,
      setThreadLastAction,
      threadId,
      getAgentChatContext,
      canvasId,
      setThreadLoading,
      conversationView,
      previewTabId,
    ],
  );

  const stopStream = useCallback(() => {
    // Stop this session's thread. Tell the server, then abort our local
    // subscription so callbacks stop firing.
    const tid = threadId;
    void agentApi.stopThread(tid);
    abortAgentStreamClaim(
      conversationRequestScope(conversationView, canvasId).canvasId,
      tid,
    );

    const controller = abortControllersRef.current.get(tid);
    if (controller) {
      controller.abort();
      abortControllersRef.current.delete(tid);
    }
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
            if (s.status !== 'pending' && s.status !== 'in_progress') return s;
            return { ...s, status: 'failed' };
          }),
        };
      });
    }
  }, [
    addMessage,
    updateMessage,
    setThreadLoading,
    threadId,
    conversationView,
    canvasId,
  ]);

  // `useChatHistory` reconnect flips loading on/off explicitly for the
  // owner thread of the reconnect attempt. We simply re-expose
  // `setThreadLoading` so the caller is forced to name the thread —
  // no implicit "current thread" coupling.
  const setIsLoading = setThreadLoading;

  return {
    isLoading,
    setIsLoading,
    startStream,
    stopStream,
  };
}
