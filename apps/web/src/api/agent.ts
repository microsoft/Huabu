// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unified Agent API Client
 *
 * Communicates with the unified `/api/agent` endpoint that handles all
 * modes (chat, agent) with pi-ai streaming.
 */

import { AGENT_HOST_SSE_EVENTS, AGENT_SSE_EVENTS } from '@huabu/shared';

import { ApiError, apiErrorFromResponse, apiFetch, apiUrl } from './_client';
import { routes } from './_routes';
import { readTypedSSEStream } from './_sse';

import type {
  AgentBinding,
  AgentHostStreamEvent,
  AgentInputKind,
  AgentMode,
  AgentRequest,
  AgentStreamEvent,
  AgentTurnAccepted,
  AgentChatContext,
  AgentHistoryPageResponse,
  ChatAttachment,
  VisibleCanvasGrounding,
  ChatHistoryResponse,
  ContextTokensResponse,
  ForkThreadResponse,
  StopThreadResponse,
} from '@huabu/shared';

// ==================== Stream Callbacks ====================

export interface AgentStreamCallbacks {
  onAccepted?: (acceptance: AgentTurnAccepted) => void;
  /** Called for each streaming event */
  onEvent: (event: AgentStreamEvent) => void;
  /** Called on error */
  onError: (error: Error) => void;
  /** Called when stream completes */
  onComplete: () => void;
}

export type AgentStreamAttachResult =
  | { status: 'completed' }
  | { status: 'inactive' }
  | { status: 'aborted' };

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
): Promise<'done' | 'end' | 'error' | null> {
  let terminal: 'done' | 'end' | 'error' | null = null;

  await readTypedSSEStream<AgentHostStreamEvent>(
    response,
    (event) => {
      if (terminal === 'end' || terminal === 'error') return;

      if (event.type === AGENT_HOST_SSE_EVENTS.Accepted) {
        if (
          !event.data ||
          typeof event.data.threadId !== 'string' ||
          event.data.threadId.length === 0 ||
          !Number.isSafeInteger(event.data.turnStartSeq) ||
          event.data.turnStartSeq <= 0
        ) {
          throw new Error('Invalid agent acceptance');
        }
        callbacks.onAccepted?.(event.data);
        return;
      }

      if (event.type === AGENT_SSE_EVENTS.End) {
        terminal = 'end';
        callbacks.onComplete();
        return;
      }
      if (event.type === AGENT_SSE_EVENTS.Error) {
        terminal = 'error';
        callbacks.onError(
          new Error(event.data.error || 'Unknown server error'),
        );
        return;
      }
      if (event.type === AGENT_SSE_EVENTS.Done) {
        terminal = 'done';
      }
      if (options?.suppressMeta && event.type === AGENT_SSE_EVENTS.Meta) {
        return;
      }

      callbacks.onEvent(event);
    },
    signal,
  );

  return terminal;
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
   * Fetch a bounded page of complete display turns. Omitting `before` reads
   * the newest page and may include the active Tier-1 tail.
   */
  fetchHistoryPage: async (
    threadId: string,
    canvasId: string,
    limit: number,
    before?: string,
  ): Promise<AgentHistoryPageResponse> => {
    return apiFetch<AgentHistoryPageResponse>(
      routes.agentHistoryPage(threadId, canvasId, limit, before),
      { fallbackMessage: 'Failed to load history' },
    );
  },

  /**
   * Realize a new thread from a source conversation so a duplicated question
   * node continues independently from the same materialized history.
   */
  forkThread: async (
    threadId: string,
    targetThreadId: string,
    canvasId?: string,
    targetCanvasId?: string,
  ): Promise<ForkThreadResponse> => {
    return await apiFetch<ForkThreadResponse>(
      routes.agentHistoryFork(threadId, canvasId),
      {
        method: 'POST',
        json: { targetThreadId, targetCanvasId },
        fallbackMessage: 'Failed to fork conversation',
      },
    );
  },

  /**
   * Explicitly stop an active agent run on the server.
   * Transport failures reject because the server may already have accepted
   * the stop; callers must keep observing the original stream until its
   * acceptance/terminal state resolves.
   */
  stopThread: async (
    threadId: string,
    canvasId?: string,
  ): Promise<StopThreadResponse> => {
    return await apiFetch<StopThreadResponse>(
      routes.agentStop(threadId, canvasId),
      { method: 'POST' },
    );
  },

  /**
   * Reconnect to an active agent run after page refresh.
   * Distinguishes inactivity and intentional abort from completed replay.
   * Unexpected HTTP, transport, parse, or premature-EOF failures reject.
   */
  reconnectStream: async (
    threadId: string,
    canvasId: string | undefined,
    callbacks: AgentStreamCallbacks,
    signal?: AbortSignal,
  ): Promise<AgentStreamAttachResult> => {
    try {
      const response = await fetch(
        apiUrl(routes.agentStream(threadId, canvasId)),
        {
          signal,
        },
      );

      if (response.status === 404) return { status: 'inactive' };
      if (!response.ok || !response.body) {
        if (!response.ok) {
          throw await apiErrorFromResponse(
            response,
            `Agent stream failed with HTTP ${response.status}`,
          );
        }
        throw new Error('Agent stream response body is null');
      }

      const terminal = await pumpAgentStream(response, callbacks, signal, {
        suppressMeta: true,
      });
      if (!terminal) {
        throw new Error('Agent stream ended before a terminal event');
      }
      if (terminal === 'done') callbacks.onComplete();
      return { status: 'completed' };
    } catch (error) {
      if (signal?.aborted) return { status: 'aborted' };
      throw error;
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
      inputKind?: AgentInputKind;
      canvasContext?: AgentChatContext;
      canvasId?: string;
      attachments?: ChatAttachment[];
      groundingVisual?: VisibleCanvasGrounding;
      /**
       * Anchor a node-neighbourhood preamble to this node id. When
       * set, the server resolves the surrounding-canvas context from
       * persisted topology and pushes a `[SYSTEM Context]` preamble
       * (rendered from the Ask agent's `nodeNeighbourhoodPreamble`
       * template) before the actual user message. Sent today by
       * `useQuestionRunner`; anchor-type agnostic.
       */
      anchorNodeId?: string;
      /**
       * Thread → agent binding. The client is the source of truth for
       * this mapping; the server reads it per-request to decide whether
       * to run the built-in agent or dispatch to an ACP agent.
       * Defaults to internal when omitted.
       */
      agentBinding?: AgentBinding;
      /**
       * Skill ids the user explicitly invoked by typing `/<id>` in the
       * chat input (parsed by `useInternalSlashCommands`). Forwarded
       * verbatim; the server fetches each skill body and prepends a
       * SYSTEM preamble for this turn so the agent treats the skill
       * as authoritative. Capped server-side at 8.
       */
      invokedSkills?: string[];
      /**
       * Built-in agent per-thread capability selection carried with this
       * turn so a model / reasoning effort picked before the thread's
       * first message is applied on thread creation. Ignored for external
       * bindings.
       */
      modelId?: string;
      reasoningEffort?: string;
      signal?: AbortSignal;
    },
  ): Promise<void> => {
    const body: AgentRequest = {
      content,
      inputKind: options?.inputKind,
      threadId,
      mode,
      canvasContext: options?.canvasContext,
      canvasId: options?.canvasId,
      attachments: options?.attachments?.length
        ? options.attachments
        : undefined,
      groundingVisual: options?.groundingVisual,
      anchorNodeId: options?.anchorNodeId,
      agentBinding: options?.agentBinding,
      invokedSkills: options?.invokedSkills?.length
        ? options.invokedSkills
        : undefined,
      modelId: options?.modelId,
      // The valid set is enforced server-side (zod). The client value
      // originates from the model's own capability list plus `off`, so the
      // cast is safe; a stray value is rejected on the server.
      reasoningEffort:
        options?.reasoningEffort as AgentRequest['reasoningEffort'],
    };

    try {
      const response = await fetch(apiUrl(routes.agent), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: options?.signal,
      });

      if (!response.ok) {
        throw await apiErrorFromResponse(
          response,
          `Agent request failed with HTTP ${response.status}`,
        );
      }
      if (!response.body) {
        throw new Error('Response body is null');
      }

      const terminal = await pumpAgentStream(
        response,
        callbacks,
        options?.signal,
      );
      if (!terminal) callbacks.onComplete();
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
