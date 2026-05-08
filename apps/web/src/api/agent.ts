/**
 * Unified Agent API Client
 *
 * Communicates with the unified `/api/agent` endpoint that handles all
 * modes (chat, agent) with pi-ai streaming.
 */

import { AGENT_SSE_EVENTS } from '@sediment/shared';

import { ApiError, apiFetch, apiUrl } from './_client';
import { routes } from './_routes';
import { readTypedSSEStream } from './_sse';

import type {
  AgentMode,
  AgentRequest,
  AgentStreamEvent,
  AgentBaseContext,
  ChatAttachment,
  ChatHistoryResponse,
  ContextTokensResponse,
  IntentCandidate,
  StopThreadResponse,
} from '@sediment/shared';

// ==================== Stream Callbacks ====================

export interface AgentStreamCallbacks {
  /** Called for each streaming event */
  onEvent: (event: AgentStreamEvent) => void;
  /** Called on error */
  onError: (error: Error) => void;
  /** Called when stream completes */
  onComplete: () => void;
}

/**
 * Drive `callbacks` from a streaming SSE Response. Centralised so
 * `streamMessage` and `reconnectStream` share the same parsing rules.
 *
 * `event: end` and `event: error` terminate the stream and short-circuit
 * the callbacks. The optional `meta` event is suppressed for reconnects
 * (it carries thread-binding info, not user-visible content).
 */
async function pumpAgentStream(
  response: Response,
  callbacks: AgentStreamCallbacks,
  signal?: AbortSignal,
  options?: { suppressMeta?: boolean },
): Promise<boolean> {
  let terminated = false;

  await readTypedSSEStream<AgentStreamEvent>(
    response,
    (event) => {
      if (terminated) return;

      if (event.type === AGENT_SSE_EVENTS.End) {
        terminated = true;
        callbacks.onComplete();
        return;
      }
      if (event.type === AGENT_SSE_EVENTS.Error) {
        terminated = true;
        callbacks.onError(
          new Error(event.data.error || 'Unknown server error'),
        );
        return;
      }
      if (options?.suppressMeta && event.type === AGENT_SSE_EVENTS.Meta) {
        return;
      }

      callbacks.onEvent(event);
    },
    signal,
  );

  return terminated;
}

// ==================== API ====================

export const agentApi = {
  /**
   * Fetch conversation history for a thread.
   */
  fetchHistory: async (
    threadId: string,
    canvasId?: string,
  ): Promise<ChatHistoryResponse> => {
    try {
      return await apiFetch<ChatHistoryResponse>(
        routes.agentHistory(threadId, canvasId),
        { fallbackMessage: 'Failed to load history' },
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        throw new Error('Thread not found');
      }
      throw err;
    }
  },

  /**
   * Explicitly stop an active agent run on the server.
   * Best-effort — swallow transport errors so the UI never blocks on stop.
   */
  stopThread: async (threadId: string): Promise<void> => {
    try {
      await apiFetch<StopThreadResponse>(routes.agentStop(threadId), {
        method: 'POST',
      });
    } catch {
      /* best-effort */
    }
  },

  /**
   * Reconnect to an active agent run after page refresh.
   * Returns false if no active run exists (404), otherwise streams events.
   */
  reconnectStream: async (
    threadId: string,
    callbacks: AgentStreamCallbacks,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    try {
      const response = await fetch(apiUrl(routes.agentStream(threadId)), {
        signal,
      });

      if (response.status === 404) return false;
      if (!response.ok || !response.body) return false;

      const terminated = await pumpAgentStream(response, callbacks, signal, {
        suppressMeta: true,
      });
      if (!terminated) callbacks.onComplete();
      return true;
    } catch {
      return false;
    }
  },

  /**
   * Send a message and stream the response via SSE.
   * Pass an AbortSignal to allow cancellation of the stream.
   */
  streamMessage: async (
    content: string,
    threadId: string,
    mode: AgentMode,
    callbacks: AgentStreamCallbacks,
    options?: {
      canvasContext?: AgentBaseContext;
      canvasId?: string;
      attachments?: ChatAttachment[];
      selectedNodeIds?: string[];
      intentData?: {
        candidates: IntentCandidate[];
        selectedIntent: string;
      };
      signal?: AbortSignal;
    },
  ): Promise<void> => {
    const body: AgentRequest = {
      content,
      threadId,
      mode,
      canvasContext: options?.canvasContext,
      canvasId: options?.canvasId,
      attachments: options?.attachments?.length
        ? options.attachments
        : undefined,
      selectedNodeIds: options?.selectedNodeIds?.length
        ? options.selectedNodeIds
        : undefined,
      intentData: options?.intentData,
    };

    try {
      const response = await fetch(apiUrl(routes.agent), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: options?.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      if (!response.body) {
        throw new Error('Response body is null');
      }

      const terminated = await pumpAgentStream(
        response,
        callbacks,
        options?.signal,
      );
      if (!terminated) callbacks.onComplete();
    } catch (error) {
      // Treat any error while the signal is aborted as an intentional stop
      if (options?.signal?.aborted) {
        callbacks.onComplete();
        return;
      }
      console.error('[agent] Stream error:', error);
      callbacks.onError(
        error instanceof Error ? error : new Error('Unknown stream error'),
      );
    }
  },

  /**
   * Fetch the current context token count for a conversation thread.
   */
  fetchContextTokens: async (
    threadId: string,
    canvasId?: string,
    signal?: AbortSignal,
  ): Promise<ContextTokensResponse> => {
    return apiFetch<ContextTokensResponse>(
      routes.agentContextTokens(threadId, canvasId),
      { signal, fallbackMessage: 'Failed to fetch context tokens' },
    );
  },
};
