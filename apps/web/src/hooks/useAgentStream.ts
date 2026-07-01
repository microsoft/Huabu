import { useCallback, useRef, useEffect } from 'react';

import {
  createId,
  variantForInternalTool,
  type AssistantToolPart,
  type AssistantToolVariant,
  type CanvasCommand,
  type CanvasEdgeId,
  type CanvasNodeId,
  type ImageGenerationData,
  type SnapshotNodesData,
  type ToolResponse,
  type WebSearchToolResponse,
} from '@sediment/shared';

import { agentApi } from '@/api/agent';
import useCanvasStore from '@/store/canvasStore';
import { useChatStore } from '@/store/chatStore';

import { snapshotAndExtractChanges } from './useCanvasChanges';

import type { AssistantSegment } from '../store/chatTypes';
import type {
  AgentMode,
  AgentStreamEvent,
  IntentCandidate,
} from '@sediment/shared';
import type { Delta } from '@sediment/shared/canvas-engine';
import type { Node } from '@xyflow/react';

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
 * Parse a canvas_commands tool result, snapshot prestate for revert,
 * apply the server-authored deltas, and return the executor's
 * annotated commands plus change entries.
 *
 * After M2 (headless executor) the server's `canvas_commands` handler
 * returns an enriched envelope:
 *   `{ source, canvasId, commands, runId, fromVersion, toVersion,
 *      deltas, results, pendingEffects }`
 * where `commands` are the annotated commands the executor actually
 * ran (ids assigned), `deltas` is the structural diff we apply
 * locally via `applyDeltasFromAgent`, and `pendingEffects` carries
 * the web-only drain manifest (preprocessing dispatch, delete
 * tracking, AI-edit flag, deferred frame fit).
 *
 * Legacy fallback: when the envelope lacks `deltas` (e.g. the sketch
 * carve-out that still returns `{ source, canvasId, commands }`) we
 * fall back to local engine execution. This keeps the sketch pipeline
 * working without touching its API surface — M3 will collapse the two
 * paths once cross-tab broadcast lands.
 *
 * Returns the same `{ commands, changes }` shape as before so the
 * downstream tool-card wiring stays untouched.
 */
export function applyCanvasCommandsFromToolResult(
  toolResult: string | undefined,
): {
  commands: CanvasCommand[];
  changes: ReturnType<typeof snapshotAndExtractChanges>;
} | null {
  try {
    const parsed = JSON.parse(toolResult ?? '{}') as {
      status?: string;
      commands?: unknown;
      deltas?: unknown;
      toVersion?: unknown;
      broadcast?: unknown;
      pendingEffects?: {
        mutatedNodes?: unknown;
        deletedNodeIds?: unknown;
        contentEditedNodeIds?: unknown;
        deferredFitFrameIds?: unknown;
      };
    };

    // Error envelopes produced by the SSE bridge — nothing to apply.
    if (parsed.status === 'error') return null;

    const commands = parsed.commands;
    if (!Array.isArray(commands) || commands.length === 0) return null;

    // Server-authored path (M2): deltas + version are present.
    const hasServerExecution =
      Array.isArray(parsed.deltas) && typeof parsed.toVersion === 'number';

    if (hasServerExecution) {
      const typedCommands = commands as CanvasCommand[];

      // When the server broadcast this write (interactive chat agent),
      // canvas state arrives via the sync stream — applying it here too
      // would double-apply on the initiating tab. Revert is owned by the
      // broadcast-fed `AcpChangeCard`, so we also skip the client-side
      // change extraction and return empty `changes`; the per-message
      // card falls back to a display-only reconstruction.
      if (parsed.broadcast === true) {
        animateAgentBatch(typedCommands);
        return { commands: typedCommands, changes: [] };
      }

      // Non-broadcast callers (question node / sketch carve-out) still
      // apply the server-authored deltas locally from the tool result
      // and drive the per-message revert card from a client snapshot.
      const changes = snapshotAndExtractChanges(typedCommands);

      const pe = parsed.pendingEffects;
      useCanvasStore
        .getState()
        .applyDeltasFromAgent(
          parsed.deltas as Delta[],
          parsed.toVersion as number,
          {
            mutatedNodes: Array.isArray(pe?.mutatedNodes)
              ? (pe.mutatedNodes as Node[])
              : [],
            deletedNodeIds: Array.isArray(pe?.deletedNodeIds)
              ? (pe.deletedNodeIds as string[])
              : [],
            contentEditedNodeIds: Array.isArray(pe?.contentEditedNodeIds)
              ? (pe.contentEditedNodeIds as string[])
              : [],
            deferredFitFrameIds: Array.isArray(pe?.deferredFitFrameIds)
              ? (pe.deferredFitFrameIds as string[])
              : [],
          },
        );

      animateAgentBatch(typedCommands);
      return { commands: typedCommands, changes };
    }

    // Legacy / sketch carve-out path: execute locally via the engine.
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

    const typedCommands = commands as CanvasCommand[];
    const changes = snapshotAndExtractChanges(typedCommands);

    useCanvasStore.getState().executeCommands(typedCommands, 'agent');

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
  /**
   * The thread that owns this stream. Captured at send time; all
   * message reads / writes inside the SSE handler key off this — never
   * `state.threadId` — so events keep landing on the originating
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

/**
 * Module-level sink for session-meta events. A single subscriber (the
 * ChatPanel's `useAcpSessionMeta` hook) registers itself on mount via
 * {@link setAcpSessionMetaSink} so `handleStreamEvent` can dispatch
 * meta updates without re-plumbing every event through props.
 *
 * Last-writer-wins by design — there is only ever one ChatPanel
 * mounted at a time (the canvas chat OR a question-thread view, never
 * both), so concurrent subscribers would be a bug.
 */
type AcpSessionMetaSink = (event: AcpSessionMetaStreamEvent) => void;
let acpSessionMetaSink: AcpSessionMetaSink | null = null;
export function setAcpSessionMetaSink(sink: AcpSessionMetaSink | null): void {
  acpSessionMetaSink = sink;
}

/**
 * Ensure an assistant message exists for `ctx.assistantId`. Used by
 * the tool-call / plan handlers which may fire before any text_delta.
 */
function ensureAssistantMessage(ctx: StreamEventContext): void {
  const { addMessage, messagesByThread } = useChatStore.getState();
  const list = messagesByThread[ctx.threadId] ?? [];
  const existing = list.find((m) => m.id === ctx.assistantId);
  if (!existing) {
    addMessage(ctx.threadId, {
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
  const provisional: ToolResponse<string, unknown> = {
    tool: toolName,
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
 * provisional args recorded by {@link applyInternalToolStart}, mark
 * the part completed, and — for `canvas_commands` — execute the
 * commands locally and attach the live `canvasChanges`.
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
  const { upsertAssistantToolPart, messagesByThread } = useChatStore.getState();
  const toolResponse = parseToolResponse(toolName, rawText);
  if (!toolResponse) return;

  const variant = variantForInternalTool(toolName);
  const assistantMsg = (messagesByThread[ctx.threadId] ?? []).find(
    (m) => m.id === ctx.assistantId,
  );
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

  // Execute canvas_commands locally.
  if (toolName === 'canvas_commands') {
    const result = applyCanvasCommandsFromToolResult(rawText);
    if (result) {
      // Attach the live canvasChanges array to the canvas_commands
      // tool part's typed `data` envelope (this is the canonical
      // home that `CanvasCommandCard` reads from).
      if (result.changes.length > 0) {
        upsertAssistantToolPart(
          ctx.threadId,
          ctx.assistantId,
          toolCallId,
          (existing) => {
            if (!existing) {
              // Should never happen — we just inserted above. Bail
              // safely by returning a minimal part.
              return mergeToolPart(existing, toolCallId, {
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
          },
        );
      }
    }
  }
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
  const {
    addMessage,
    updateMessage,
    upsertAssistantToolPart,
    messagesByThread,
  } = useChatStore.getState();
  // All reads / writes below key off the owner thread captured on
  // `ctx`, never the currently-visible thread. This is what makes
  // mid-stream thread switches safe — events keep landing on the
  // thread that issued the request.
  const ownerMessages = messagesByThread[ctx.threadId] ?? [];

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
        : priorPart?.variant === 'canvas_commands' ||
            priorPart?.variant === 'web_search'
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
    // the ChatPanel's mode/model/config selector dropdowns. Hand off
    // to the registered sink (see {@link setAcpSessionMetaSink}); if
    // no panel is mounted (e.g. tests, headless reconnect), drop.
    acpSessionMetaSink?.(event);
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
    intentData?: {
      candidates: IntentCandidate[];
      selectedIntent: string;
    },
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
 */
export function useAgentStream(): UseAgentStreamReturn {
  const threadId = useChatStore((state) => state.threadId);
  // Loading is per-thread (a question node thread can stream
  // independently of the canvas chat), so read the flag for the
  // currently-visible thread from the store.
  const isLoading = useChatStore((state) =>
    state.loadingThreadIds.has(state.threadId),
  );
  const setThreadLoading = useChatStore((state) => state.setThreadLoading);

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

  // Per-thread abort controllers. We can have multiple streams in
  // flight at once (canvas chat + one or more question threads), so a
  // single ref would clobber a still-running run when the next send
  // starts on a different thread.
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());

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
      invokedSkills?: string[],
    ) => {
      // Per-thread guard: this thread's own loading flag, not any other
      // thread's. The user may already have a stream running in a
      // different chat (canvas chat + question node both active).
      if (
        !prompt.trim() ||
        useChatStore.getState().loadingThreadIds.has(threadId)
      )
        return;

      setLastAction(agentMode);

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
      const anchorQuestionNodeId =
        useChatStore.getState().viewingQuestionThread?.nodeId ?? null;

      // Selected node ids are still recorded on the persisted user
      // message so the UI can re-render the selection chip after a
      // reload, even though we no longer derive any attachments from
      // them client-side.
      const selectedNodeIds = useCanvasStore
        .getState()
        .nodes.filter((n) => n.selected && n.id !== anchorQuestionNodeId)
        .map((n) => n.id);

      const mergedAttachments = [...allPending];
      const attachments =
        mergedAttachments.length > 0 ? mergedAttachments : undefined;
      if (allPending.length > 0) {
        clearPendingAttachments();
        useChatStore.getState().setSelectionAttachment(null);
      }

      // For intent-driven operate calls, show an intent-select widget instead of user bubble
      if (intentData && agentMode === 'operate') {
        addMessage(threadId, {
          id: createId('intent'),
          role: 'intent-select',
          candidates: intentData.candidates,
          selectedIntent: intentData.selectedIntent,
        });
      } else {
        addMessage(threadId, {
          id: createId('message'),
          role: 'user',
          content: prompt,
          attachments,
          ...(selectedNodeIds.length > 0 ? { selectedNodeIds } : {}),
          ...(invokedSkills && invokedSkills.length > 0
            ? { invokedSkills }
            : {}),
        });
      }

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
      };

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
        // First send of a freshly-composed question node: author the
        // node's `content` from this prompt and lock in the agent the
        // user picked in the inline selector (binding + built-in mode).
        // Clearing the `compose` flag flips the panel from "editable
        // composer" to replay semantics for every follow-up turn.
        const isCompose = viewingQuestion?.compose === true;
        if (isCompose) {
          useChatStore.setState({
            viewingQuestionThread: {
              nodeId: questionNodeId,
              threadId,
              compose: false,
            },
          });
          // Author content through the intent pipeline so it gets a
          // markdown sidecar save + server-side label preprocessing —
          // matching how the inline editor used to commit the prompt.
          useCanvasStore
            .getState()
            .updateNodeData(questionNodeId, { content: prompt });
        }
        const composeBinding = isCompose
          ? {
              agentBinding: useChatStore.getState().agentBinding,
              agentMode,
            }
          : {};
        // Reset `viewed` so the layer-panel dot + on-canvas "done · unread"
        // glow re-appear when the follow-up answer lands (mirrors
        // `useQuestionRunner`'s initial-run behaviour). `onComplete`
        // marks it viewed again if the user is still in the thread.
        useCanvasStore.getState().patchNodeSilent(questionNodeId, {
          status: 'running',
          errorMessage: undefined,
          viewed: false,
          ...composeBinding,
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

      // Build the canvas context, dropping the anchored question node
      // from `selectedNodes` for the same reason as `selectedNodeIds`
      // above — it is the conversation anchor, not a separate source.
      const baseCanvasContext = getAgentChatContext();
      const canvasContext = anchorQuestionNodeId
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
              if (event.type === 'done') sawDone = true;
              handleStreamEvent(event, {
                threadId,
                assistantId,
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
              setThreadLoading(threadId, false);
              releaseAbort();
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
                const stillViewing =
                  useChatStore.getState().viewingQuestionThread?.nodeId ===
                  questionNodeId;
                useCanvasStore.getState().patchNodeSilent(questionNodeId, {
                  status: 'done',
                  errorMessage: undefined,
                  ...(stillViewing ? { viewed: true } : {}),
                });
              }
              setThreadLoading(threadId, false);
              releaseAbort();
            },
          },
          {
            canvasContext,
            canvasId: canvasId || undefined,
            attachments,
            intentData,
            agentBinding,
            anchorNodeId: questionNodeId ?? undefined,
            invokedSkills,
            signal: abortController.signal,
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
            const stillViewing =
              useChatStore.getState().viewingQuestionThread?.nodeId ===
              questionNodeId;
            useCanvasStore.getState().patchNodeSilent(questionNodeId, {
              status: 'done',
              errorMessage: undefined,
              ...(stillViewing ? { viewed: true } : {}),
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
      setLastAction,
      threadId,
      getAgentChatContext,
      canvasId,
      setThreadLoading,
      updateMessage,
    ],
  );

  const stopStream = useCallback(() => {
    // Stop the currently-visible thread. Tell the server, then abort
    // our local subscription so callbacks stop firing.
    const tid = useChatStore.getState().threadId;
    void agentApi.stopThread(tid);

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
    const msgs = useChatStore.getState().messagesByThread[tid] ?? [];
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
  }, [addMessage, updateMessage, setThreadLoading]);

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
