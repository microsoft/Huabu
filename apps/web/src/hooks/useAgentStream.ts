import {
  createId,
  variantForInternalTool,
  type AssistantToolPart,
  type AssistantToolVariant,
  type CanvasCommand,
  type CanvasEdgeId,
  type CanvasNodeId,
  type ToolResponse,
  type WebSearchToolResponse,
} from '@sediment/shared';
import { useState, useCallback, useRef, useEffect } from 'react';

import { agentApi } from '@/api/agent';
import { buildSketchAttachmentsFromSelection } from '@/handler/sketch/buildSketchAttachments';
import useCanvasStore from '@/store/canvasStore';
import { useChatStore } from '@/store/chatStore';

import { snapshotAndExtractChanges } from './useCanvasChanges';

import type { AssistantSegment, ResourceLabel } from '../store/chatTypes';
import type {
  AgentMode,
  AgentStreamEvent,
  ChatAttachment,
  IntentCandidate,
} from '@sediment/shared';

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

/** Extract CanvasChange entries from a canvas_commands batch. */
export function extractCanvasChangesFromCommands(commands: CanvasCommand[]) {
  // Delegate to snapshotAndExtractChanges which reads current canvas state
  // NOTE: This must be called BEFORE commands are executed.
  return snapshotAndExtractChanges(commands);
}

/** Extract ResourceLabel entries from a canvas_commands batch. */
export function extractResourcesFromCommands(
  commands: CanvasCommand[],
): ResourceLabel[] {
  const resources: ResourceLabel[] = [];
  for (const cmd of commands) {
    if (cmd.type === 'CREATE_NODES') {
      for (const node of cmd.nodes) {
        const label = (node.data as Record<string, unknown> | undefined)?.label;
        resources.push({
          type: node.nodeType === 'frame' ? 'frame' : 'node',
          nodeType: node.nodeType,
          label: (label as string) ?? 'untitled',
          id: node.id as string,
        });
      }
    }
  }
  return resources;
}

// ==================== Constants ====================

/** Duration of each element's opacity transition (ms). */
const ENTER_ANIM_DURATION = 300;

/** Stagger delay between consecutive elements in the reveal queue (ms). */
const ENTER_ANIM_STAGGER = 200;

// ==================== Animation State ====================
// Singleton module state — only valid because useAgentStream is mounted once
// (in ChatPanel). Do NOT import this hook from additional components.

/** Pending timeouts for the current animation so they can be cancelled. */
let animTimers: ReturnType<typeof setTimeout>[] = [];
/** IDs of nodes currently being animated (may have opacity: 0). */
let animNodeIds = new Set<string>();
/** IDs of edges currently being animated (may have opacity: 0). */
let animEdgeIds = new Set<string>();

/**
 * Cancel any in-progress entrance animation and immediately reveal all
 * elements.  Safe to call at any time — no-op when nothing is animating.
 *
 * Exported so external code (e.g. canvas-change preview) can clear the
 * animation before snapshotting state.
 */
export function cancelAgentAnimation(): void {
  for (const t of animTimers) clearTimeout(t);
  animTimers = [];

  if (animNodeIds.size === 0 && animEdgeIds.size === 0) return;

  const nIds = animNodeIds;
  const eIds = animEdgeIds;
  animNodeIds = new Set();
  animEdgeIds = new Set();

  // Animation cleanup is a transient visual write — use the no-autosave
  // setter so resetting opacity/transition does not schedule an empty
  // structure PUT or reset the autosave debounce.
  useCanvasStore.getState()._setStateNoAutosave((state) => ({
    nodes: state.nodes.map((n) => {
      if (!nIds.has(n.id)) return n;
      const {
        opacity: _nOp,
        transition: _nTr,
        ...rest
      } = (n.style ?? {}) as Record<string, unknown>;
      return { ...n, style: { ...rest, opacity: 1 } };
    }),
    edges: state.edges.map((e) => {
      if (!eIds.has(e.id)) return e;
      const {
        opacity: _op,
        transition: _tr,
        ...rest
      } = (e.style ?? {}) as Record<string, unknown>;
      return { ...e, style: { ...rest, opacity: 1 } };
    }),
  }));
}

// ==================== Side-effectful Helpers ====================

/**
 * Build a reveal queue from commands in execution order, then reveal
 * each element one by one with a staggered delay.
 *
 * Queue items are interleaved following command order:
 *   CREATE_NODES → each node is one queue slot
 *   CONNECT_NODES → each edge is one queue slot
 *   Other command types → skipped (they don't create visible elements)
 */
function animateAgentBatch(commands: CanvasCommand[]): void {
  // Build ordered reveal queue: { type: 'node' | 'edge', id }
  const queue: { kind: 'node' | 'edge'; id: string }[] = [];
  for (const cmd of commands) {
    if (cmd.type === 'CREATE_NODES') {
      for (const n of cmd.nodes) {
        if (n.id) queue.push({ kind: 'node', id: n.id as string });
      }
    } else if (cmd.type === 'CONNECT_NODES') {
      for (const e of cmd.edges) {
        if (e.id) queue.push({ kind: 'edge', id: e.id as string });
      }
    }
  }
  if (queue.length === 0) return;

  // Cancel any previous animation that may still be running.
  cancelAgentAnimation();

  const newNodeIds = new Set(
    queue.filter((q) => q.kind === 'node').map((q) => q.id),
  );
  const newEdgeIds = new Set(
    queue.filter((q) => q.kind === 'edge').map((q) => q.id),
  );

  animNodeIds = new Set(newNodeIds);
  animEdgeIds = new Set(newEdgeIds);

  const transition = `opacity ${ENTER_ANIM_DURATION}ms ease-out`;

  // Step 1: Hide everything that's in the queue. Transient visual
  // write — bypass autosave (the engine commands that CREATED these
  // nodes already scheduled a structure PUT; the opacity ramp must not
  // pile on additional ones nor reset that debounce).
  useCanvasStore.getState()._setStateNoAutosave((state) => ({
    nodes: state.nodes.map((n) => {
      if (!newNodeIds.has(n.id)) return n;
      return { ...n, style: { ...n.style, opacity: 0, transition } };
    }),
    edges: state.edges.map((e) => {
      if (!newEdgeIds.has(e.id)) return e;
      return { ...e, style: { ...e.style, opacity: 0, transition } };
    }),
  }));

  // Step 2: Reveal each queue item in order.
  for (const [idx, item] of queue.entries()) {
    const timer = setTimeout(() => {
      if (item.kind === 'node') {
        animNodeIds.delete(item.id);
        useCanvasStore.getState()._setStateNoAutosave((state) => ({
          nodes: state.nodes.map((n) =>
            n.id === item.id ? { ...n, style: { ...n.style, opacity: 1 } } : n,
          ),
        }));
      } else {
        animEdgeIds.delete(item.id);
        useCanvasStore.getState()._setStateNoAutosave((state) => ({
          edges: state.edges.map((e) =>
            e.id === item.id ? { ...e, style: { ...e.style, opacity: 1 } } : e,
          ),
        }));
      }
    }, idx * ENTER_ANIM_STAGGER);
    animTimers.push(timer);
  }

  // Step 3: Clean up transition styles after everything is visible.
  const totalMs = queue.length * ENTER_ANIM_STAGGER + ENTER_ANIM_DURATION;
  const cleanupTimer = setTimeout(() => {
    animTimers = [];
    animNodeIds = new Set();
    animEdgeIds = new Set();
    useCanvasStore.getState()._setStateNoAutosave((state) => ({
      nodes: state.nodes.map((n) => {
        if (!newNodeIds.has(n.id)) return n;
        const { transition: _, ...rest } = (n.style ?? {}) as Record<
          string,
          unknown
        >;
        return { ...n, style: rest };
      }),
      edges: state.edges.map((e) => {
        if (!newEdgeIds.has(e.id)) return e;
        const { transition: _, ...rest } = (e.style ?? {}) as Record<
          string,
          unknown
        >;
        return { ...e, style: rest };
      }),
    }));
  }, totalMs);
  animTimers.push(cleanupTimer);
}

/**
 * Parse a canvas_commands tool result, pre-assign missing IDs,
 * snapshot current state for revert, execute commands, and return
 * the enriched commands plus change entries.
 *
 * The server's canvas_commands handler returns a flat
 * `{ source, canvasId, commands }` JSON payload (see
 * apps/server/src/modules/agent/tools/handlers/canvas-write.ts). On
 * tool errors, agent.service.ts wraps the payload as
 * `{ tool, status: 'error', error }` — we skip those here.
 */
function applyCanvasCommandsFromToolResult(toolResult: string | undefined): {
  commands: CanvasCommand[];
  changes: ReturnType<typeof snapshotAndExtractChanges>;
} | null {
  try {
    const parsed = JSON.parse(toolResult ?? '{}') as {
      status?: string;
      commands?: unknown;
    };

    // Error envelopes produced by the SSE bridge — nothing to apply.
    if (parsed.status === 'error') return null;

    // Be strict about shape: the field must be an array. Anything else
    // (object, string, missing) is treated as "no commands". This
    // protects the for-of loop below from a server-side regression
    // where `commands` accidentally becomes an array-like or arg-pass-
    // through value with a numeric `length` property.
    const commands = parsed.commands;
    if (!Array.isArray(commands) || commands.length === 0) return null;

    // Pre-assign IDs to nodes/edges that don't have them
    for (const cmd of commands as CanvasCommand[]) {
      if (cmd.type === 'CREATE_NODES') {
        for (const node of cmd.nodes) {
          if (!node.id) {
            node.id = createId('node') as CanvasNodeId;
          }
        }
      } else if (cmd.type === 'CONNECT_NODES') {
        for (const edge of cmd.edges) {
          if (!edge.id) {
            edge.id = createId('edge') as CanvasEdgeId;
          }
        }
      }
    }

    // Snapshot BEFORE execution so revert commands capture current state
    const typedCommands = commands as CanvasCommand[];
    const changes = snapshotAndExtractChanges(typedCommands);

    useCanvasStore.getState().executeCommands(typedCommands, 'agent');

    // Staggered entrance animation following command execution order
    animateAgentBatch(typedCommands);

    return { commands: typedCommands, changes };
  } catch (err) {
    console.error(
      '[useAgentStream] Failed to parse canvas_commands result:',
      err,
    );
  }
  return null;
}

// ==================== SSE Event Handler ====================

interface StreamEventContext {
  assistantId: string;
  /**
   * Fallback FIFO of `toolCallId`s emitted by the *legacy*
   * `tool_start` events. Used only when the matching `tool_result`
   * arrives without its own `toolCallId` (older servers / synthetic
   * events in tests). With `toolCallId` present we look up the tool
   * part directly on the assistant message; parallel completion
   * order ≠ start order stays correct.
   *
   * `tool_call` / `tool_call_update` events never touch this queue:
   * they carry a mandatory `toolCallId` and address the tool part on
   * the owning assistant message directly.
   */
  toolQueue: { fifo: string[] };
  /** Called after canvas_commands are applied. */
  onCanvasCommands?: (commands: CanvasCommand[]) => void;
  /**
   * ID of the pending PreparedPromptCard message inserted by
   * `startStream` for external-agent turns. When the server emits its
   * `prepared_prompt` event we update this message in place; when
   * absent (reconnect path) we append a fresh one.
   */
  preparedPromptId?: string;
}

/**
 * Ensure an assistant message exists for `ctx.assistantId`. Used by
 * the tool-call / plan handlers which may fire before any text_delta.
 */
function ensureAssistantMessage(ctx: StreamEventContext): void {
  const { addMessage } = useChatStore.getState();
  const existing = useChatStore
    .getState()
    .messages.find((m) => m.id === ctx.assistantId);
  if (!existing) {
    addMessage({
      id: ctx.assistantId,
      role: 'assistant',
      segments: [],
    });
  }
}

/**
 * Merge a tool_call / tool_call_update / tool_start / tool_result
 * payload onto an existing tool part, preserving the variant tag.
 *
 * The `variant` is fixed by the FIRST observation (the producer
 * always knows it): ACP `tool_call` events arrive as `generic`; the
 * legacy `tool_start` handler computes the variant from the tool
 * name via {@link variantForInternalTool}. Subsequent updates never
 * change the variant — only enrich its fields.
 */
function mergeToolPart(
  existing: AssistantToolPart | undefined,
  toolCallId: string,
  patch: {
    variant?: AssistantToolVariant;
    toolName?: string;
    title?: string;
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
    case 'canvas_commands': {
      const data = (patch.data ??
        (existing?.variant === 'canvas_commands'
          ? existing.data
          : undefined)) as
        | ToolResponse<'canvas_commands', Record<string, unknown>>
        | undefined;
      return {
        ...base,
        variant: 'canvas_commands',
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
    case 'generic':
      return { ...base, variant: 'generic' };
  }
}

/**
 * Shared SSE event handler used by both reconnect and normal streaming.
 * Processes text_delta / thinking_delta / tool_call / tool_call_update /
 * plan, plus the legacy tool_start / tool_result pair (folded into the
 * owning assistant message), by updating chat messages and executing
 * canvas commands.
 */
export function handleStreamEvent(
  event: AgentStreamEvent,
  ctx: StreamEventContext,
): void {
  const { addMessage, updateMessage, upsertAssistantToolPart } =
    useChatStore.getState();

  if (event.type === 'text_delta' || event.type === 'thinking_delta') {
    const delta = event.data.content;
    if (!delta) return;
    const kind: AssistantSegment['kind'] =
      event.type === 'text_delta' ? 'text' : 'thinking';
    const existing = useChatStore
      .getState()
      .messages.find((m) => m.id === ctx.assistantId);
    if (existing) {
      updateMessage(ctx.assistantId, (m) => {
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
      addMessage({
        id: ctx.assistantId,
        role: 'assistant',
        segments: [{ kind, text: delta }],
      });
    }
  } else if (event.type === 'tool_call') {
    const data = event.data;
    ensureAssistantMessage(ctx);
    upsertAssistantToolPart(ctx.assistantId, data.toolCallId, (existing) =>
      mergeToolPart(existing, data.toolCallId, {
        // ACP `tool_call` events always materialise as `generic`;
        // the wire shape carries only ACP-spec fields.
        variant: 'generic',
        title: data.title,
        toolKind: data.toolKind,
        status: data.status,
        locations: data.locations,
        content: data.content,
      }),
    );
  } else if (event.type === 'tool_call_update') {
    const data = event.data;
    ensureAssistantMessage(ctx);
    upsertAssistantToolPart(ctx.assistantId, data.toolCallId, (existing) =>
      mergeToolPart(existing, data.toolCallId, {
        title: data.title,
        status: data.status,
        locations: data.locations,
        content: data.content,
        rawOutput: data.rawOutput,
      }),
    );
  } else if (event.type === 'plan') {
    const entries = event.data.entries;
    ensureAssistantMessage(ctx);
    updateMessage(ctx.assistantId, (m) => {
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
  } else if (event.type === 'tool_start') {
    // Legacy event — fold into the assistant message as a tool part.
    const toolCallId = event.data.toolCallId ?? createId('toolcall');
    ctx.toolQueue.fifo.push(toolCallId);
    ensureAssistantMessage(ctx);
    // Stash the args as a provisional `ToolResponse` on the variant's
    // typed `data` so the rich renderers see something while the call
    // is in flight. tool_result will replace this with the real
    // response. The variant is fixed here from the tool name — every
    // subsequent update keeps it.
    const toolName = event.data.toolName;
    const variant = variantForInternalTool(toolName);
    const provisional: ToolResponse<string, unknown> = {
      tool: toolName,
      status: 'success',
      data: event.data.toolArgs,
    };
    upsertAssistantToolPart(ctx.assistantId, toolCallId, (existing) =>
      mergeToolPart(existing, toolCallId, {
        variant,
        toolName,
        title: toolName,
        status: 'pending',
        data: provisional,
      }),
    );
  } else if (event.type === 'tool_result') {
    const toolResponse = parseToolResponse(
      event.data.toolName,
      event.data.toolResult,
    );
    if (!toolResponse) return;

    // Resolve toolCallId. Prefer the explicit ID so parallel tool
    // execution stays correct; fall back to FIFO when absent.
    let toolCallId = event.data.toolCallId;
    if (toolCallId) {
      const idx = ctx.toolQueue.fifo.indexOf(toolCallId);
      if (idx !== -1) ctx.toolQueue.fifo.splice(idx, 1);
    } else {
      toolCallId = ctx.toolQueue.fifo.shift();
    }
    if (!toolCallId) {
      // No matching tool_start — synthesize a standalone tool part so
      // the result is not silently dropped.
      toolCallId = createId('toolcall');
    }

    // Merge provisional args (from tool_start) with the real response.
    const toolName = event.data.toolName;
    const variant = variantForInternalTool(toolName);
    const assistantMsg = useChatStore
      .getState()
      .messages.find((m) => m.id === ctx.assistantId);
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
        priorPart && priorPart.variant !== 'generic'
          ? priorPart.data
          : undefined;
      if (priorData && priorData.status === 'success') {
        existingArgs =
          (priorData.data as Record<string, unknown> | undefined) ?? {};
      }
    }
    const mergedResponse: ToolResponse<string, unknown> = {
      ...toolResponse,
      data: {
        ...existingArgs,
        ...((toolResponse.status === 'success'
          ? toolResponse.data
          : {}) as Record<string, unknown>),
      },
    } as ToolResponse<string, unknown>;

    ensureAssistantMessage(ctx);
    upsertAssistantToolPart(ctx.assistantId, toolCallId, (existing) =>
      mergeToolPart(existing, toolCallId!, {
        variant,
        toolName,
        title: existing?.title ?? toolName,
        status: 'completed',
        data: mergedResponse,
      }),
    );

    // Execute canvas_commands locally
    if (event.data.toolName === 'canvas_commands') {
      const result = applyCanvasCommandsFromToolResult(event.data.toolResult);
      if (result) {
        // Attach the live canvasChanges array to the canvas_commands
        // tool part's typed `data` envelope (this is the canonical
        // home that `CanvasCommandCard` reads from).
        if (result.changes.length > 0) {
          upsertAssistantToolPart(ctx.assistantId, toolCallId, (existing) => {
            if (!existing) {
              // Should never happen — we just inserted above. Bail
              // safely by returning a minimal part.
              return mergeToolPart(existing, toolCallId!, {
                variant: 'canvas_commands',
                data: mergedResponse,
              });
            }
            if (existing.variant !== 'canvas_commands') return existing;
            const existingData = existing.data;
            const priorData =
              existingData?.status === 'success'
                ? ((existingData.data as Record<string, unknown> | undefined) ??
                  {})
                : {};
            return {
              ...existing,
              data: {
                tool: 'canvas_commands',
                status: 'success',
                data: {
                  ...priorData,
                  canvasChanges: result.changes,
                },
              },
            };
          });
        }
        ctx.onCanvasCommands?.(result.commands);
      }
    }
  } else if (event.type === 'prepared_prompt') {
    // External-agent only: the server's preprocessor finished. If
    // startStream already inserted a pending placeholder we update it
    // in place; otherwise (reconnect path) we append a fresh one.
    const pendingId = ctx.preparedPromptId;
    const existing = pendingId
      ? useChatStore.getState().messages.find((m) => m.id === pendingId)
      : undefined;
    if (existing) {
      updateMessage(pendingId!, (m) =>
        m.role === 'prepared-prompt'
          ? {
              ...m,
              prompt: event.data.prompt,
              agentAlias: event.data.agentAlias,
              ...(event.data.error
                ? { error: event.data.error }
                : { error: undefined }),
            }
          : m,
      );
    } else {
      addMessage({
        id: createId('preparedPrompt'),
        role: 'prepared-prompt',
        prompt: event.data.prompt,
        agentAlias: event.data.agentAlias,
        ...(event.data.error ? { error: event.data.error } : {}),
      });
    }
  }
}

// ==================== Hook ====================

export interface UseAgentStreamReturn {
  isLoading: boolean;
  /** Expose setter so useChatHistory can update loading state on reconnect. */
  setIsLoading: (loading: boolean) => void;
  /** Start a streaming agent request. */
  startStream: (
    prompt: string,
    agentMode: AgentMode,
    intentData?: {
      candidates: IntentCandidate[];
      selectedIntent: string;
    },
  ) => Promise<void>;
  /** Stop the current stream. */
  stopStream: () => void;
}

/**
 * Hook that manages agent streaming, including starting/stopping streams,
 * processing SSE events, and tracking resources.
 */
export function useAgentStream(): UseAgentStreamReturn {
  const [isLoading, setIsLoading] = useState(false);

  const threadId = useChatStore((state) => state.threadId);
  const addMessage = useChatStore((state) => state.addMessage);
  const updateMessage = useChatStore((state) => state.updateMessage);
  const setLastAction = useChatStore((state) => state.setLastAction);
  const pendingAttachments = useChatStore((state) => state.pendingAttachments);
  const selectionAttachment = useChatStore(
    (state) => state.selectionAttachment,
  );
  const clearPendingAttachments = useChatStore(
    (state) => state.clearPendingAttachments,
  );

  const getAgentChatContext = useCanvasStore(
    (state) => state.getAgentChatContext,
  );
  const canvasId = useCanvasStore((state) => state.canvasId);

  // Track resources across the current agent run
  const resourcesRef = useRef<ResourceLabel[]>([]);
  const assistantIdRef = useRef<string>('');
  const abortControllerRef = useRef<AbortController | null>(null);

  // Track whether the component is still active (not unloading).
  // Prevents adding spurious "network error" status on page refresh.
  const activeRef = useRef(true);
  useEffect(() => {
    activeRef.current = true;
    const onUnload = () => {
      activeRef.current = false;
    };
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      activeRef.current = false;
    };
  }, []);

  const startStream = useCallback(
    async (
      prompt: string,
      agentMode: AgentMode,
      intentData?: {
        candidates: IntentCandidate[];
        selectedIntent: string;
      },
    ) => {
      if (!prompt.trim() || isLoading) return;

      setLastAction(agentMode);

      // Merge pending attachments + selection attachment into a single array
      const allPending = [
        ...pendingAttachments,
        ...(selectionAttachment ? [selectionAttachment] : []),
      ];

      const allNodes = useCanvasStore.getState().nodes;
      const selectedNodeIds = allNodes
        .filter((n) => n.selected)
        .map((n) => n.id);

      // If the user selected sketch nodes, rasterise each spatial cluster
      // (scoped per parent frame) into a PNG attachment so the vision
      // pipeline can see the gesture without a separate sketch-recognition
      // round-trip. Failure here must not block the chat send — we log
      // and proceed with whatever attachments did succeed.
      let sketchAttachments: ChatAttachment[] = [];
      if (selectedNodeIds.length > 0) {
        try {
          sketchAttachments = await buildSketchAttachmentsFromSelection(
            selectedNodeIds,
            allNodes,
          );
        } catch (err) {
          console.error('[useAgentStream] sketch attachment build failed', err);
        }
      }

      const mergedAttachments = [...allPending, ...sketchAttachments];
      const attachments =
        mergedAttachments.length > 0 ? mergedAttachments : undefined;
      if (allPending.length > 0) {
        clearPendingAttachments();
        useChatStore.getState().setSelectionAttachment(null);
      }

      // For intent-driven operate calls, show an intent-select widget instead of user bubble
      if (intentData && agentMode === 'operate') {
        addMessage({
          id: createId('intent'),
          role: 'intent-select',
          candidates: intentData.candidates,
          selectedIntent: intentData.selectedIntent,
        });
      } else {
        addMessage({
          id: createId('message'),
          role: 'user',
          content: prompt,
          attachments,
          ...(selectedNodeIds.length > 0 ? { selectedNodeIds } : {}),
        });
      }

      setIsLoading(true);

      // Operate: reset resource tracking (canvas changes persist until explicit keep/revert)
      if (agentMode === 'operate') {
        resourcesRef.current = [];
      }

      const assistantId = createId('message');
      assistantIdRef.current = assistantId;

      const toolMsgQueue: StreamEventContext['toolQueue'] = {
        fifo: [],
      };

      // Guard: ensure only one of onError / catch adds an error status
      let errorHandled = false;

      // Create abort controller for this stream
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      // ── Question-node follow-up bookkeeping ─────────────────────────
      //
      // When the chat panel is currently rendering a question node's
      // thread (`viewingQuestionThread` is set), every message the user
      // sends is a follow-up turn against that node. The question node
      // owns a `status` field (`idle | pending | running | done | error`)
      // that the canvas badge reads. The dedicated `useQuestionRunner`
      // hook only manages the *initial* auto-run; follow-ups travel
      // through this hook, so we are the only place that can keep that
      // badge honest across multi-turn conversations.
      //
      // We also track whether a successful `done` event was observed so
      // a late cap-out `error` event (`Agent loop exceeded maximum
      // iterations`) emitted *after* a complete answer doesn't flip the
      // node to `error` (issue 3 — tool failures during a successful
      // agent run should not poison the final status).
      const viewingQuestion = useChatStore.getState().viewingQuestionThread;
      const questionNodeId = viewingQuestion?.nodeId ?? null;
      let sawDone = false;

      if (questionNodeId) {
        useCanvasStore.getState().patchNodeSilent(questionNodeId, {
          status: 'running',
          errorMessage: undefined,
        });
      }

      // Make sure any buffered behavioural events have hit the server
      // before the agent builds its request context. Failures are
      // swallowed inside the flush helper — we never want a transient
      // network blip to block the agent call.
      await useCanvasStore.getState().flushCanvasEvents();

      // Snapshot the current thread → agent binding at send time. The
      // server is stateless about bindings; we pass it per-request so
      // the server-side dispatch sees exactly which agent the user
      // picked for this thread.
      const agentBinding = useChatStore.getState().agentBinding;

      // External-binding only: insert a pending "Preparing prompt …"
      // card immediately so the user sees something the moment they
      // hit send. The server's `prepared_prompt` event will populate
      // this same message in place. If preprocessing fails server-side
      // we get a `prepared_prompt` with `error` set — still the same
      // slot, no flash. We capture its ID into the StreamEventContext
      // so `handleStreamEvent` knows which message to update.
      let preparedPromptId: string | undefined;
      if (agentBinding?.kind === 'external') {
        preparedPromptId = createId('preparedPrompt');
        addMessage({
          id: preparedPromptId,
          role: 'prepared-prompt',
          prompt: null,
          agentAlias: agentBinding.alias,
        });
      }

      try {
        await agentApi.streamMessage(
          prompt,
          threadId,
          agentMode,
          {
            onEvent: (event: AgentStreamEvent) => {
              if (event.type === 'done') sawDone = true;
              handleStreamEvent(event, {
                assistantId,
                toolQueue: toolMsgQueue,
                preparedPromptId,
                onCanvasCommands: (commands) => {
                  if (agentMode === 'operate') {
                    const newResources = extractResourcesFromCommands(commands);
                    if (newResources.length > 0) {
                      resourcesRef.current = [
                        ...resourcesRef.current,
                        ...newResources,
                      ];
                    }
                  }
                },
              });
            },
            onError: (err) => {
              if (!activeRef.current || errorHandled) return;
              errorHandled = true;
              console.error(`${agentMode} error:`, err);
              // Question-node follow-up: only flip to `error` if no
              // useful final `done` event ever arrived. A cap-out error
              // emitted after a successful answer is treated as success.
              if (questionNodeId) {
                useCanvasStore.getState().patchNodeSilent(questionNodeId, {
                  status: sawDone ? 'done' : 'error',
                  errorMessage: sawDone ? undefined : err.message,
                });
              }
              addMessage({
                id: createId('status'),
                role: 'status',
                status: 'error',
                detail: err.message,
              });
              setIsLoading(false);
              abortControllerRef.current = null;
            },
            onComplete: () => {
              setIsLoading(false);
              abortControllerRef.current = null;

              if (questionNodeId) {
                useCanvasStore.getState().patchNodeSilent(questionNodeId, {
                  status: 'done',
                  errorMessage: undefined,
                });
              }

              if (agentMode === 'operate' && resourcesRef.current.length > 0) {
                updateMessage(assistantIdRef.current, (m) =>
                  m.role === 'assistant'
                    ? { ...m, resources: [...resourcesRef.current] }
                    : m,
                );
              }
            },
          },
          {
            canvasContext: getAgentChatContext(),
            canvasId: canvasId || undefined,
            attachments,
            intentData,
            agentBinding,
            anchorNodeId: questionNodeId ?? undefined,
            signal: abortController.signal,
          },
        );
      } catch (err) {
        // Abort is not an error — stream was intentionally stopped
        if (abortController.signal.aborted) {
          setIsLoading(false);
          abortControllerRef.current = null;
          // User explicitly stopped: roll the question node back to
          // `done` (preserve any partial reply the server kept) rather
          // than leaving it stuck on `running`.
          if (questionNodeId) {
            useCanvasStore.getState().patchNodeSilent(questionNodeId, {
              status: 'done',
              errorMessage: undefined,
            });
          }
          return;
        }
        // Page unloading — don't persist error
        if (!activeRef.current) return;
        // Skip if onError callback already handled this
        if (errorHandled) return;
        errorHandled = true;
        console.error(`${agentMode} failed:`, err);
        if (questionNodeId) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          useCanvasStore.getState().patchNodeSilent(questionNodeId, {
            status: sawDone ? 'done' : 'error',
            errorMessage: sawDone ? undefined : message,
          });
        }
        addMessage({
          id: createId('status'),
          role: 'status',
          status: 'error',
          detail: err instanceof Error ? err.message : 'Unknown error',
        });
        setIsLoading(false);
      }
    },
    [
      isLoading,
      pendingAttachments,
      selectionAttachment,
      clearPendingAttachments,
      addMessage,
      setLastAction,
      threadId,
      updateMessage,
      getAgentChatContext,
      canvasId,
    ],
  );

  const stopStream = useCallback(() => {
    // Tell the server to stop the active run
    const tid = useChatStore.getState().threadId;
    void agentApi.stopThread(tid);

    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setIsLoading(false);

    // Show interrupted status in chat
    addMessage({
      id: createId('status'),
      role: 'status',
      status: 'interrupted',
    });

    // Mark any still-pending tool parts as cancelled so the renderer
    // can drop spinners / show a definitive end state.
    const msgs = useChatStore.getState().messages;
    for (const msg of msgs) {
      if (msg.role !== 'assistant') continue;
      const hasInflight = msg.segments.some(
        (s) =>
          s.kind === 'tool' &&
          (s.status === 'pending' || s.status === 'in_progress'),
      );
      if (!hasInflight) continue;
      updateMessage(msg.id, (m) => {
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
  }, [addMessage, updateMessage]);

  return {
    isLoading,
    setIsLoading,
    startStream,
    stopStream,
  };
}
