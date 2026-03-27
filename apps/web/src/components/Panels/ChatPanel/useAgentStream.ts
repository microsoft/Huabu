import {
  createId,
  type CanvasCommand,
  type CanvasEdgeId,
  type CanvasNodeId,
  type ToolResponse,
} from '@sediment/shared';
import { useState, useCallback, useRef, useEffect } from 'react';

import { agentApi } from '@/api/agent';
import useCanvasStore from '@/store/canvasStore';
import { useChatStore } from '@/store/chatStore';

import { snapshotAndExtractChanges } from '../../../hooks/useCanvasChanges';

import type { ResourceLabel } from '../../Messages/types';
import type {
  AgentMode,
  AgentStreamEvent,
  IntentCandidate,
} from '@sediment/shared';

// ==================== Pure Utility Functions ====================

/**
 * Parse a tool result string into a proper ToolResponse.
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
    return { tool: toolName, status: 'success', data: parsed };
  } catch {
    return { tool: toolName, status: 'success', data: { content: raw } };
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

// ==================== Side-effectful Helpers ====================

/**
 * Parse a canvas_commands tool result, pre-assign missing IDs,
 * snapshot current state for revert, execute commands, and return
 * the enriched commands plus change entries.
 */
function applyCanvasCommandsFromToolResult(toolResult: string | undefined): {
  commands: CanvasCommand[];
  changes: ReturnType<typeof snapshotAndExtractChanges>;
} | null {
  try {
    const parsed = JSON.parse(toolResult ?? '{}') as {
      status?: string;
      data?: { commands?: CanvasCommand[] };
    };
    if (parsed.status === 'success' && parsed.data?.commands?.length) {
      const commands = parsed.data.commands;

      // Pre-assign IDs to nodes/edges that don't have them
      for (const cmd of commands) {
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
      const changes = snapshotAndExtractChanges(commands);

      useCanvasStore.getState().executeCommands(commands, 'agent');
      return { commands, changes };
    }
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
  toolQueue: string[];
  /** Called after canvas_commands are applied. */
  onCanvasCommands?: (
    commands: CanvasCommand[],
    toolMsgId: string | undefined,
  ) => void;
}

/**
 * Shared SSE event handler used by both reconnect and normal streaming.
 * Processes text_delta, tool_start, tool_result events by updating chat
 * messages and executing canvas commands.
 */
export function handleStreamEvent(
  event: AgentStreamEvent,
  ctx: StreamEventContext,
): void {
  const { addMessage, updateMessage } = useChatStore.getState();

  if (event.type === 'text_delta') {
    const delta = event.data.content ?? '';
    const existing = useChatStore
      .getState()
      .messages.find((m) => m.id === ctx.assistantId);
    if (existing) {
      updateMessage(ctx.assistantId, (m) =>
        m.role === 'user' || m.role === 'assistant'
          ? { ...m, content: m.content + delta }
          : m,
      );
    } else {
      addMessage({
        id: ctx.assistantId,
        role: 'assistant',
        content: delta,
      });
    }
  } else if (event.type === 'tool_start') {
    const toolName = event.data.toolName ?? 'unknown';
    const msgId = createId('tool');
    ctx.toolQueue.push(msgId);
    addMessage({
      id: msgId,
      role: 'tool',
      toolResponse: {
        tool: toolName,
        status: 'success',
        data: event.data.toolArgs ?? {},
      },
      isExecuting: true,
    });
  } else if (event.type === 'tool_result') {
    const toolResponse = parseToolResponse(
      event.data.toolName ?? 'unknown',
      event.data.toolResult,
    );
    if (!toolResponse) return;

    // Merge original tool args with the result data
    const pendingMsgId = ctx.toolQueue.shift();
    let finalResponse = toolResponse;
    if (pendingMsgId) {
      const existingMsg = useChatStore
        .getState()
        .messages.find((m) => m.id === pendingMsgId);
      const existingArgs =
        existingMsg?.role === 'tool' &&
        existingMsg.toolResponse.status === 'success'
          ? (existingMsg.toolResponse.data as Record<string, unknown>)
          : {};
      finalResponse = {
        ...toolResponse,
        data: {
          ...existingArgs,
          ...((toolResponse.status === 'success'
            ? toolResponse.data
            : {}) as Record<string, unknown>),
        },
      } as typeof toolResponse;
      updateMessage(pendingMsgId, () => ({
        id: pendingMsgId,
        role: 'tool' as const,
        toolResponse: finalResponse,
        isExecuting: false,
      }));
    } else {
      addMessage({
        id: createId('tool'),
        role: 'tool',
        toolResponse: finalResponse,
      });
    }

    // Execute canvas_commands locally
    if ((event.data.toolName ?? '') === 'canvas_commands') {
      const result = applyCanvasCommandsFromToolResult(event.data.toolResult);
      if (result) {
        // Attach changes to the tool message
        const toolMsgId = pendingMsgId ?? undefined;
        if (toolMsgId && result.changes.length > 0) {
          updateMessage(toolMsgId, (m) => {
            if (m.role !== 'tool' || m.toolResponse.status !== 'success')
              return m;
            return {
              ...m,
              toolResponse: {
                ...m.toolResponse,
                data: {
                  ...(m.toolResponse.data as Record<string, unknown>),
                  canvasChanges: result.changes,
                },
              },
            };
          });
        }
        ctx.onCanvasCommands?.(result.commands, toolMsgId);
      }
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

  const getAgentContext = useCanvasStore((state) => state.getAgentContext);
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
      const attachments = allPending.length > 0 ? allPending : undefined;
      if (attachments) {
        clearPendingAttachments();
        useChatStore.getState().setSelectionAttachment(null);
      }

      const selectedNodeIds = useCanvasStore
        .getState()
        .nodes.filter((n) => n.selected)
        .map((n) => n.id);

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

      const toolMsgQueue: string[] = [];

      // Guard: ensure only one of onError / catch adds an error status
      let errorHandled = false;

      // Create abort controller for this stream
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      try {
        await agentApi.streamMessage(
          prompt,
          threadId,
          agentMode,
          {
            onEvent: (event: AgentStreamEvent) => {
              handleStreamEvent(event, {
                assistantId,
                toolQueue: toolMsgQueue,
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
            canvasContext: getAgentContext(),
            canvasId: canvasId || undefined,
            attachments,
            selectedNodeIds:
              selectedNodeIds.length > 0 ? selectedNodeIds : undefined,
            signal: abortController.signal,
          },
        );
      } catch (err) {
        // Abort is not an error — stream was intentionally stopped
        if (abortController.signal.aborted) {
          setIsLoading(false);
          abortControllerRef.current = null;
          return;
        }
        // Page unloading — don't persist error
        if (!activeRef.current) return;
        // Skip if onError callback already handled this
        if (errorHandled) return;
        errorHandled = true;
        console.error(`${agentMode} failed:`, err);
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
      getAgentContext,
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

    // Mark any still-executing tool messages as done
    const msgs = useChatStore.getState().messages;
    for (const msg of msgs) {
      if (msg.role === 'tool' && msg.isExecuting) {
        updateMessage(msg.id, (m) =>
          m.role === 'tool' ? { ...m, isExecuting: false } : m,
        );
      }
    }
  }, [addMessage, updateMessage]);

  return {
    isLoading,
    setIsLoading,
    startStream,
    stopStream,
  };
}
