import {
  createId,
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
import { useResearchStore } from '@/store/researchStore';

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

/** Tools that modify the canvas and should be tracked for the change bar. */
const CANVAS_MODIFY_TOOLS = new Set([
  'create_node',
  'update_node',
  'delete_nodes',
  'connect_nodes',
  'disconnect_nodes',
  'create_frame',
]);

/** Extract a CanvasChange from a tool response, or null if not canvas-modifying. */
function extractCanvasChange(
  toolResponse: ToolResponse<string, unknown>,
): CanvasChange | null {
  if (!CANVAS_MODIFY_TOOLS.has(toolResponse.tool)) return null;
  if (toolResponse.status !== 'success') return null;
  const data = (toolResponse.data ?? {}) as Record<string, unknown>;
  const truncate = (s: string, n: number) =>
    s.length > n ? s.slice(0, n) + '…' : s;

  switch (toolResponse.tool) {
    case 'create_node':
      return {
        tool: 'create_node',
        label: `Created: ${truncate((data.label as string) ?? 'untitled', 24)}`,
        nodeType: (data.type as string) ?? 'note',
        nodeId: data.nodeId as string,
      };
    case 'update_node':
      return {
        tool: 'update_node',
        label: `Updated: ${truncate((data.nodeId as string) ?? '', 24)}`,
        nodeType: 'note',
        nodeId: data.nodeId as string,
      };
    case 'delete_nodes':
      return {
        tool: 'delete_nodes',
        label: `Deleted ${(data.deletedCount as number) ?? ''} node(s)`,
      };
    case 'connect_nodes':
      return {
        tool: 'connect_nodes',
        label: 'Connected nodes',
        sourceNodeId: data.sourceId as string,
        targetNodeId: data.targetId as string,
      };
    case 'disconnect_nodes':
      return { tool: 'disconnect_nodes', label: 'Disconnected nodes' };
    case 'create_frame':
      return {
        tool: 'create_frame',
        label: 'Created frame',
        nodeType: 'frame',
      };
    default:
      return null;
  }
}

/** Extract a ResourceLabel from a tool response. */
function extractResource(
  toolResponse: ToolResponse<string, unknown>,
): ResourceLabel | null {
  if (toolResponse.status !== 'success') return null;
  const data = toolResponse.data as Record<string, unknown>;

  if (toolResponse.tool === 'create_node') {
    return {
      type: 'node',
      nodeType: (data.type as string) ?? 'note',
      label: (data.label as string) ?? 'untitled',
      id: data.nodeId as string,
    };
  }
  if (toolResponse.tool === 'create_frame') {
    return {
      type: 'frame',
      nodeType: 'frame',
      label: 'Frame',
      id: data.frameId as string,
    };
  }
  return null;
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
  const refreshCanvas = useCanvasStore((state) => state.refreshCanvas);

  // Switch chat thread when canvas changes
  useEffect(() => {
    if (canvasId) {
      useChatStore.getState().switchToCanvas(canvasId);
    }
  }, [canvasId]);

  // Research store — tracks running status for UI (disable input, etc.)
  const researchStatus = useResearchStore((state) => state.status);
  const startResearchUi = useResearchStore((state) => state.startResearch);
  const completeResearchUi = useResearchStore(
    (state) => state.completeResearch,
  );
  const setResearchError = useResearchStore((state) => state.setError);

  const messagesEndRef = useRef<HTMLDivElement>(null);

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

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading]);

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
            };
            return {
              id,
              role: msg.role,
              content: msg.content || '',
              ...(msg.attachments &&
                msg.attachments.length > 0 && {
                  attachments: msg.attachments,
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

          if (event.type === 'text_delta') {
            const delta = (event.data as Record<string, unknown>).content ?? '';
            const existing = useChatStore
              .getState()
              .messages.find((m) => m.id === assistantId);
            if (existing) {
              updateMessage(assistantId, (m) =>
                m.role === 'user' || m.role === 'assistant'
                  ? { ...m, content: m.content + (delta as string) }
                  : m,
              );
            } else {
              addMessage({
                id: assistantId,
                role: 'assistant',
                content: delta as string,
              });
            }
          } else if (event.type === 'tool_start') {
            const toolName =
              (event.data as Record<string, unknown>).toolName ?? 'unknown';
            const msgId = createId('tool');
            toolQueue.push(msgId);
            addMessage({
              id: msgId,
              role: 'tool',
              toolResponse: {
                tool: toolName as string,
                status: 'success',
                data: ((event.data as Record<string, unknown>).toolArgs ??
                  {}) as Record<string, unknown>,
              },
              isExecuting: true,
            });
          } else if (event.type === 'tool_result') {
            const toolResponse = parseToolResponse(
              ((event.data as Record<string, unknown>).toolName ??
                'unknown') as string,
              (event.data as Record<string, unknown>).toolResult as
                | string
                | undefined,
            );
            if (toolResponse) {
              const pendingMsgId = toolQueue.shift();
              if (pendingMsgId) {
                const existingMsg = useChatStore
                  .getState()
                  .messages.find((m) => m.id === pendingMsgId);
                const existingArgs =
                  existingMsg?.role === 'tool' &&
                  existingMsg.toolResponse.status === 'success'
                    ? (existingMsg.toolResponse.data as Record<string, unknown>)
                    : {};
                const finalResponse = {
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
                  toolResponse,
                });
              }
              void refreshCanvas();
            }
          }
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
          void refreshCanvas();
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
      if (agentMode === 'research' && researchStatus === 'running') return;

      setLastAction(agentMode);

      const attachments =
        pendingAttachments.length > 0 ? [...pendingAttachments] : undefined;
      if (attachments) clearPendingAttachments();

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
        });
      }

      setIsLoading(true);

      // Research: update UI status store
      if (agentMode === 'research') {
        startResearchUi(prompt, {
          searchDepth: 'basic',
          placement: 'auto',
          groupWithFrame: true,
        });
      }

      // Operate: reset change tracking
      if (agentMode === 'operate') {
        setCanvasChanges([]);
        resourcesRef.current = [];
      }

      const assistantId = createId('message');
      assistantIdRef.current = assistantId;

      const toolMsgQueue: string[] = [];

      // Whether this mode modifies the canvas (needs refresh after tool calls)
      const modifiesCanvas =
        agentMode === 'operate' || agentMode === 'research';

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
              if (event.type === 'text_delta') {
                const delta = event.data.content ?? '';
                const existing = useChatStore
                  .getState()
                  .messages.find((m) => m.id === assistantId);
                if (existing) {
                  updateMessage(assistantId, (m) =>
                    m.role === 'user' || m.role === 'assistant'
                      ? { ...m, content: m.content + delta }
                      : m,
                  );
                } else {
                  addMessage({
                    id: assistantId,
                    role: 'assistant',
                    content: delta,
                  });
                }
              } else if (event.type === 'tool_start') {
                const toolName = event.data.toolName ?? 'unknown';
                const msgId = createId('tool');
                toolMsgQueue.push(msgId);
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
                if (toolResponse) {
                  // Merge original tool args with the result data
                  const pendingMsgId = toolMsgQueue.shift();
                  let finalResponse = toolResponse;
                  if (pendingMsgId) {
                    const existingMsg = useChatStore
                      .getState()
                      .messages.find((m) => m.id === pendingMsgId);
                    const existingArgs =
                      existingMsg?.role === 'tool' &&
                      existingMsg.toolResponse.status === 'success'
                        ? (existingMsg.toolResponse.data as Record<
                            string,
                            unknown
                          >)
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

                  // Track canvas changes for the change bar (operate mode)
                  if (agentMode === 'operate') {
                    const change = extractCanvasChange(finalResponse);
                    if (change) {
                      setCanvasChanges((prev) => [...prev, change]);
                    }
                    const resource = extractResource(finalResponse);
                    if (resource) {
                      resourcesRef.current = [
                        ...resourcesRef.current,
                        resource,
                      ];
                    }
                  }

                  if (modifiesCanvas) {
                    void refreshCanvas();
                  }
                }
              }
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
              if (agentMode === 'research') {
                setResearchError(err.message);
              }
            },
            onComplete: () => {
              const wasAborted = abortController.signal.aborted;
              setIsLoading(false);
              abortControllerRef.current = null;

              if (agentMode === 'research') {
                completeResearchUi();
                // Refresh canvas to pick up research-created nodes
                if (!wasAborted) {
                  void refreshCanvas();
                }
              }

              if (agentMode === 'operate') {
                if (!wasAborted) {
                  void refreshCanvas();
                }
                if (resourcesRef.current.length > 0) {
                  updateMessage(assistantIdRef.current, (m) =>
                    m.role === 'assistant'
                      ? { ...m, resources: [...resourcesRef.current] }
                      : m,
                  );
                }
              }
            },
          },
          {
            canvasContext: getAgentContext(),
            canvasId: canvasId || undefined,
            attachments,
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
        if (agentMode === 'research') {
          setResearchError(
            err instanceof Error ? err.message : 'Unknown error',
          );
        }
      }
    },
    [
      isLoading,
      researchStatus,
      pendingAttachments,
      clearPendingAttachments,
      addMessage,
      setLastAction,
      threadId,
      updateMessage,
      refreshCanvas,
      getAgentContext,
      canvasId,
      startResearchUi,
      completeResearchUi,
      setResearchError,
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

    // Reset research store if it was running
    if (useResearchStore.getState().status === 'running') {
      useResearchStore.getState().completeResearch();
    }

    // Mark any still-executing tool messages as done
    const msgs = useChatStore.getState().messages;
    for (const msg of msgs) {
      if (msg.role === 'tool' && msg.isExecuting) {
        updateMessage(msg.id, (m) =>
          m.role === 'tool' ? { ...m, isExecuting: false } : m,
        );
      }
    }

    // Sync canvas with any partial server-side changes
    void refreshCanvas();
  }, [addMessage, updateMessage, refreshCanvas]);

  const handleNewChat = () => {
    if (isLoading || researchStatus === 'running') return;
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
          disabled={isLoading || researchStatus === 'running'}
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
          disabled={
            isLoading || !isHistoryLoaded || researchStatus === 'running'
          }
        />
      </div>
    </SidebarPanel>
  );
};
