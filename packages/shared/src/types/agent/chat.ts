import type { ExternalAgentPrompt } from './agent.js';
import type { AssistantHistoryPart } from './assistant-parts.js';
import type { IntentCandidate } from './intent.js';

/**
 * An attachment sent alongside a chat message — e.g. a captured PDF region or pasted file.
 */
export interface ChatAttachment {
  type: 'image' | 'pdf' | 'text' | 'file' | 'web';
  source: 'upload' | 'excerpt' | 'selection';
  /** Single source node (1:1 attachments such as PDF excerpts). */
  originNodeId?: string;
  /**
   * Multiple source nodes (1:N attachments such as a single image
   * rendered from a cluster of sketch strokes). Coexists with
   * `originNodeId`.
   */
  originNodeIds?: string[];
  url?: string;
  content?: string;
  label?: string;
  filename?: string;
}

// --- Chat History ---

/**
 * A single message item returned by the history endpoint.
 *
 * Assistant turns are an ordered `parts` array (`text` / `thinking` /
 * `tool` / `plan` / `status`) rather than a flat string — the wire
 * shape mirrors the live SSE aggregation so refresh and live rendering
 * share a single renderer dispatch.
 *
 * Tool calls are NOT a top-level role: they are folded into the
 * owning assistant turn as `kind:'tool'` parts. The legacy
 * `role:'tool'` variant was removed when the parts model landed (see
 * docs/assistant-segments-plan.md §3).
 */
export type ChatHistoryItem =
  | {
      role: 'user';
      content: string;
      /** Image attachments recovered from multimodal messages. */
      attachments?: ChatAttachment[];
      /** IDs of canvas nodes that were selected when this message was sent. */
      selectedNodeIds?: string[];
    }
  | {
      role: 'assistant';
      /** Ordered parts that make up the assistant turn. */
      parts: AssistantHistoryPart[];
      /** Image attachments recovered from multimodal messages. */
      attachments?: ChatAttachment[];
      /** IDs of canvas nodes that were selected when this message was sent. */
      selectedNodeIds?: string[];
    }
  | {
      role: 'status';
      status: 'interrupted' | 'error';
      /** Optional detail message for the status. */
      detail?: string;
    }
  | {
      role: 'intent-select';
      candidates: IntentCandidate[];
      selectedIntent: string;
    }
  | {
      /**
       * Structured rewrite of an external-agent user message produced
       * by the ACP preprocessor. Persisted so refreshes can show the
       * same "Prepared for <alias>" card the user saw live.
       */
      role: 'prepared-prompt';
      /** Structured prompt; `null` when the preprocessor failed. */
      prompt: ExternalAgentPrompt | null;
      /** Short alias of the bound external agent. */
      agentAlias: string;
      /** Reason the preprocessor failed; only set when `prompt === null`. */
      error?: string;
    };

/** Response from GET /api/chat/history/:threadId */
export interface ChatHistoryResponse {
  threadId: string;
  messages: ChatHistoryItem[];
}
