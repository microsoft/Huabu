import {
  createId,
  type CanvasCommand,
  type ChatAttachment,
  type ToolResponse,
} from '@sediment/shared';
import { PanelRightClose, PanelRightOpen, Plus } from 'lucide-react';
import { useState, useEffect, useCallback, useRef } from 'react';

import { agentApi } from '@/api/agent';
import { IconButton } from '@/components/Common/IconButton';
import useCanvasStore from '@/store/canvasStore';
import { useChatStore } from '@/store/chatStore';
import { useIntentStore } from '@/store/intentStore';

import { SidebarPanel } from '../SidebarPanel';
import { CanvasChangeBar, type CanvasChange } from './CanvasChangeBar';
import { ChatInput } from './ChatInput';
import { MessageList } from '../../Messages/MessageList';

import type { ChatMessage, ResourceLabel } from '../../Messages/types';
import type {
  AgentMode,
  AgentStreamEvent,
  IntentCandidate,
} from '@sediment/shared';

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
function extractCanvasChangesFromCommands(
  commands: CanvasCommand[],
): CanvasChange[] {
  const changes: CanvasChange[] = [];
  const truncate = (s: string, n: number) =>
    s.length > n ? s.slice(0, n) + '…' : s;

  for (const cmd of commands) {
    switch (cmd.type) {
      case 'CREATE_NODES':
        for (const node of cmd.nodes) {
          const label = (node.data as Record<string, unknown> | undefined)
            ?.label;
          changes.push({
            tool: 'canvas_commands',
            label: `Created: ${truncate((label as string) ?? 'untitled', 24)}`,
            nodeType: node.nodeType,
            nodeId: node.id,
          });
        }
        break;
      case 'DELETE_NODES':
        changes.push({
          tool: 'canvas_commands',
          label: `Deleted ${cmd.nodeIds.length} node(s)`,
        });
        break;
      case 'MERGE_NODE_DATA':
        for (const patch of cmd.patches) {
          changes.push({
            tool: 'canvas_commands',
            label: `Updated: ${truncate(patch.nodeId, 24)}`,
            nodeId: patch.nodeId,
          });
        }
        break;
      case 'CONNECT_NODES':
        for (const edge of cmd.edges) {
          changes.push({
            tool: 'canvas_commands',
            label: 'Connected nodes',
            sourceNodeId: edge.source,
            targetNodeId: edge.target,
          });
        }
        break;
      case 'DISCONNECT_EDGES':
        changes.push({
          tool: 'canvas_commands',
          label: `Disconnected ${cmd.edges.length} edge(s)`,
        });
        break;
      case 'SET_NODE_PARENT':
        changes.push({
          tool: 'canvas_commands',
          label: cmd.parentId ? 'Moved into frame' : 'Moved out of frame',
        });
        break;
      case 'DISSOLVE_FRAME':
        changes.push({
          tool: 'canvas_commands',
          label: 'Dissolved frame',
          nodeType: 'frame',
        });
        break;
      case 'AUTO_LAYOUT':
        changes.push({
          tool: 'canvas_commands',
          label: 'Auto layout',
        });
        break;
      default:
        break;
    }
  }
  return changes;
}

/** Extract ResourceLabel entries from a canvas_commands batch. */
function extractResourcesFromCommands(
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
          // todo: use the actual resource name after the node is created
          label: (label as string) ?? 'untitled',
          id: node.id as string,
        });
      }
    }
  }
  return resources;
}

/**
 * Parse a canvas_commands tool result, execute the commands locally,
 * and return extracted changes + resources.
 */
function applyCanvasCommandsFromToolResult(
  toolResult: string | undefined,
): { commands: CanvasCommand[] } | null {
  try {
    const parsed = JSON.parse(toolResult ?? '{}') as {
      status?: string;
      data?: { commands?: CanvasCommand[] };
    };
    if (parsed.status === 'success' && parsed.data?.commands?.length) {
      useCanvasStore.getState().executeCommands(parsed.data.commands, 'agent');
      return { commands: parsed.data.commands };
    }
  } catch (err) {
    console.error('[ChatPanel] Failed to parse canvas_commands result:', err);
  }
  return null;
}

// ==================== Shared SSE Event Handler ====================

interface StreamEventContext {
  assistantId: string;
  toolQueue: string[];
  /** Called after canvas_commands are applied. */
  onCanvasCommands?: (commands: CanvasCommand[]) => void;
}

/**
 * Shared SSE event handler used by both reconnect and normal streaming.
 * Processes text_delta, tool_start, tool_result events by updating chat
 * messages and executing canvas commands.
 */
function handleStreamEvent(
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
        ctx.onCanvasCommands?.(result.commands);
      }
    }
  }
}

interface ChatPanelProps {
  isCollapsed?: boolean;
  onToggle?: () => void;
}

export const ChatPanel = ({ isCollapsed, onToggle }: ChatPanelProps) => {
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [mode, setMode] = useState<AgentMode>('ask');

  // Canvas change tracking
  const [canvasChanges, setCanvasChanges] = useState<CanvasChange[]>([]);

  // Persistent chat state (survives page refresh)
  const threadId = useChatStore((state) => state.threadId);
  const messages = useChatStore((state) => state.messages);
  const isHistoryLoaded = useChatStore((state) => state.isHistoryLoaded);
  const addMessage = useChatStore((state) => state.addMessage);
  const updateMessage = useChatStore((state) => state.updateMessage);
  const setLastAction = useChatStore((state) => state.setLastAction);
  const clearMessages = useChatStore((state) => state.clearMessages);
  const pendingAttachments = useChatStore((state) => state.pendingAttachments);
  const clearPendingAttachments = useChatStore(
    (state) => state.clearPendingAttachments,
  );

  const getAgentContext = useCanvasStore((state) => state.getAgentContext);
  const canvasId = useCanvasStore((state) => state.canvasId);

  // Switch chat thread when canvas changes
  useEffect(() => {
    if (canvasId) {
      useChatStore.getState().switchToCanvas(canvasId);
    }
  }, [canvasId]);

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

  // Load history from server on first mount (once per thread).
  // Wait for canvasId to be available — on initial mount the canvas may
  // not have loaded yet, causing a request without canvasId that 404s.
  useEffect(() => {
    // Wait for canvasId to be set before fetching history — on initial render
    // the canvas store hasn't loaded yet, so canvasId is still ''.
    if (!canvasId) return;
    if (useChatStore.getState().isHistoryLoaded) return;

    let cancelled = false;

    const {
      threadId: tid,
      lastAction: action,
      setMessages: set,
      setHistoryLoaded: setLoaded,
    } = useChatStore.getState();

    agentApi
      .fetchHistory(tid, canvasId)
      .then((res) => {
        if (cancelled) return;

        // If the server returned a different threadId (fallback to latest),
        // update the client's threadMap so future requests use the correct id.
        if (res.threadId && res.threadId !== tid) {
          useChatStore.setState((state) => ({
            threadId: res.threadId,
            threadMap: { ...state.threadMap, [canvasId]: res.threadId },
          }));
        }

        const serverMessages: ChatMessage[] = res.messages.map(
          (m, i): ChatMessage => {
            const id = `history-${i}`;

            if (m.role === 'tool') {
              return {
                id,
                role: 'tool' as const,
                toolResponse: m.toolResponse as ToolResponse<string, unknown>,
              };
            }

            if (m.role === 'status') {
              return {
                id,
                role: 'status' as const,
                status: m.status,
                detail: m.detail,
              };
            }

            const msg = m as {
              role: 'user' | 'assistant';
              content: string;
              attachments?: ChatAttachment[];
              selectedNodeIds?: string[];
            };
            return {
              id,
              role: msg.role,
              content: msg.content || '',
              ...(msg.attachments &&
                msg.attachments.length > 0 && {
                  attachments: msg.attachments,
                }),
              ...(msg.selectedNodeIds &&
                msg.selectedNodeIds.length > 0 && {
                  selectedNodeIds: msg.selectedNodeIds,
                }),
            };
          },
        );
        set(serverMessages);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.warn(`Could not load ${action} history:`, err);
        setLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [threadId, canvasId]);

  // Try to reconnect to an active server-side run after history is loaded.
  // This handles the page-refresh case: events buffered during the refresh
  // are replayed, then live streaming resumes.
  useEffect(() => {
    if (!isHistoryLoaded || !threadId || !canvasId) return;

    let cancelled = false;

    const tryReconnect = async () => {
      const assistantId = createId('message');
      const toolQueue: string[] = [];
      // Flag set to true once we know the server has an active run
      let streaming = false;

      // Clear assistant/tool/status messages loaded from history for the
      // current run — the reconnect event buffer replays them fully.
      // Keep only messages up to and including the last user message.
      const clearStaleMessages = () => {
        const current = useChatStore.getState().messages;
        let lastUserIdx = -1;
        for (let i = current.length - 1; i >= 0; i--) {
          if (
            current[i].role === 'user' ||
            current[i].role === 'intent-select'
          ) {
            lastUserIdx = i;
            break;
          }
        }
        if (lastUserIdx >= 0) {
          useChatStore
            .getState()
            .setMessages(current.slice(0, lastUserIdx + 1));
        }
      };

      const connected = await agentApi.reconnectStream(threadId, {
        onEvent: (event: AgentStreamEvent) => {
          if (cancelled) return;
          if (!streaming) {
            streaming = true;
            setIsLoading(true);
            clearStaleMessages();
          }
          handleStreamEvent(event, { assistantId, toolQueue });
        },
        onError: (err) => {
          if (cancelled) return;
          // Clear stale messages from history before adding the error,
          // so we don't duplicate errors already loaded from history.
          clearStaleMessages();
          addMessage({
            id: createId('status'),
            role: 'status',
            status: 'error',
            detail: err.message,
          });
          setIsLoading(false);
        },
        onComplete: () => {
          if (cancelled) return;
          setIsLoading(false);
        },
      });

      if (connected && !cancelled) {
        // Reconnection was successful — events were processed above
      }
    };

    void tryReconnect();

    return () => {
      cancelled = true;
    };
    // Only run once after history loads, not on every re-render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHistoryLoaded, threadId, canvasId]);

  const handleStreamingChat = useCallback(
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

      const attachments =
        pendingAttachments.length > 0 ? [...pendingAttachments] : undefined;
      if (attachments) clearPendingAttachments();

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

      // Operate & Research: reset change tracking
      if (agentMode === 'operate' || agentMode === 'research') {
        setCanvasChanges([]);
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
                  if (agentMode === 'operate' || agentMode === 'research') {
                    const newChanges =
                      extractCanvasChangesFromCommands(commands);
                    if (newChanges.length > 0) {
                      setCanvasChanges((prev) => [...prev, ...newChanges]);
                    }
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

              if (
                (agentMode === 'operate' || agentMode === 'research') &&
                resourcesRef.current.length > 0
              ) {
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
      clearPendingAttachments,
      addMessage,
      setLastAction,
      threadId,
      updateMessage,
      getAgentContext,
      canvasId,
    ],
  );

  // Register intent callback — when user selects an intent in the popover,
  // it's sent here and executed as an agent chat message.
  useEffect(() => {
    const handleIntentChosen = (
      intent: string,
      candidates: IntentCandidate[],
    ) => {
      // Open the chat panel if collapsed
      if (isCollapsed && onToggle) {
        onToggle();
      }
      // Switch mode to operate
      setMode('operate');
      // Send as operate mode message with intent-select widget
      void handleStreamingChat(intent, 'operate', {
        candidates,
        selectedIntent: intent,
      });
    };
    useIntentStore.getState()._setOnIntentChosen(handleIntentChosen);
    return () => {
      useIntentStore.getState()._setOnIntentChosen(null);
    };
  }, [handleStreamingChat, isCollapsed, onToggle]);

  const handleIntentReselect = useCallback(
    (messageId: string, intent: string) => {
      // Update the intent-select message with the new selection
      updateMessage(messageId, (m) =>
        m.role === 'intent-select' ? { ...m, selectedIntent: intent } : m,
      );
      // Re-run with the new intent
      void handleStreamingChat(intent, 'operate');
    },
    [handleStreamingChat, updateMessage],
  );

  const handleSubmit = async (e: React.FormEvent, agentMode: AgentMode) => {
    e.preventDefault();
    const prompt = input.trim();
    setInput('');
    await handleStreamingChat(prompt, agentMode);
  };

  const handleStop = useCallback(() => {
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

  const handleNewChat = () => {
    if (isLoading) return;
    clearMessages(canvasId || undefined);
    setCanvasChanges([]);
  };

  return (
    <SidebarPanel
      title="Chat"
      isCollapsed={isCollapsed}
      onToggle={onToggle}
      iconCollapsed={<PanelRightOpen size={16} />}
      iconExpanded={<PanelRightClose size={16} />}
      className="border-border border-l"
      tools={
        <IconButton
          onClick={handleNewChat}
          title="New conversation"
          disabled={isLoading}
          className="text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus size={16} />
        </IconButton>
      }
    >
      <div className="flex h-full flex-col gap-2 overflow-visible">
        <MessageList
          messages={messages}
          isLoading={isLoading || !isHistoryLoaded}
          hideAIActions={mode === 'operate'}
          onIntentReselect={handleIntentReselect}
          onRetry={() => {
            // Find the last user message and re-send it
            const lastUserMsg = [...messages]
              .reverse()
              .find((m) => m.role === 'user');
            if (lastUserMsg && lastUserMsg.role === 'user') {
              void handleStreamingChat(lastUserMsg.content, mode);
            }
          }}
        />

        {/* Canvas change review bar */}
        {canvasChanges.length > 0 && !isLoading && (
          <CanvasChangeBar changes={canvasChanges} />
        )}

        {/* Input Area */}
        <ChatInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          onStop={handleStop}
          isStreaming={isLoading}
          mode={mode}
          onModeChange={setMode}
          disabled={isLoading || !isHistoryLoaded}
        />
      </div>
    </SidebarPanel>
  );
};
