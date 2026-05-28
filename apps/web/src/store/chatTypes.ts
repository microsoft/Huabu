/**
 * Chat message data contracts.
 *
 * These types describe the shape of messages held in `chatStore` and
 * rendered by the Messages components. They are pure data contracts —
 * deliberately kept outside `components/Messages/` so that store and
 * hooks (the actual owners of this state) don't need to reach into
 * the UI layer for their own types.
 */

import type {
  AssistantPart,
  ChatAttachment,
  ExternalAgentPrompt,
  IntentCandidate,
} from '@sediment/shared';

/** A resource label created by an agent tool call (e.g. node, edge, frame). */
export interface ResourceLabel {
  type: 'node' | 'edge' | 'frame' | 'source';
  nodeType?: string;
  label: string;
  id?: string;
}

/**
 * Ordered piece of an assistant turn. Aliased to {@link AssistantPart}
 * from the shared types package — the same union the SSE pipeline,
 * sidecar persistence, and history endpoint all speak — so live
 * streaming and rehydration share one renderer dispatch.
 *
 * Variants today: `text` / `thinking` / `tool` / `plan` / `status`.
 */
export type AssistantSegment = AssistantPart;

/** Concatenate only the visible text segments — used for copy / "add as note" / history serialization. */
export function assistantMessageText(segments: AssistantSegment[]): string {
  return segments
    .filter(
      (s): s is Extract<AssistantSegment, { kind: 'text' }> =>
        s.kind === 'text',
    )
    .map((s) => s.text)
    .join('');
}

/**
 * Top-level chat message. Tool calls are folded INTO the owning
 * assistant turn as `kind:'tool'` segments — there is no longer a
 * dedicated `role:'tool'` variant (dropped in PR-2; see
 * docs/assistant-segments-plan.md §3).
 */
export type ChatMessage =
  | {
      id: string;
      role: 'user';
      content: string;
      /** Image/file attachments included with this message. */
      attachments?: ChatAttachment[];
      /** IDs of canvas nodes selected when this message was sent. */
      selectedNodeIds?: string[];
    }
  | {
      id: string;
      role: 'assistant';
      segments: AssistantSegment[];
      /** Image/file attachments included with this message. */
      attachments?: ChatAttachment[];
      /** Resources created during the agent's response. */
      resources?: ResourceLabel[];
      /** IDs of canvas nodes selected when this message was sent. */
      selectedNodeIds?: string[];
    }
  | {
      id: string;
      role: 'status';
      status: 'interrupted' | 'error';
      detail?: string;
    }
  | {
      id: string;
      role: 'intent-select';
      /** The intent candidates to choose from. */
      candidates: IntentCandidate[];
      /** Currently selected intent label. */
      selectedIntent: string;
      /** Custom intent text typed by user. */
      customIntent?: string;
    }
  | {
      id: string;
      role: 'prepared-prompt';
      /**
       * Structured prompt the ACP preprocessor produced for the
       * external agent. `null` while we're still waiting on the
       * preprocessor's LLM call (pending state) or when the call
       * failed outright (in which case `error` is set).
       */
      prompt: ExternalAgentPrompt | null;
      /** Short alias of the bound external agent (`'claude'`, etc.). */
      agentAlias: string;
      /** Preprocessor failure detail; presence indicates the fallback path ran. */
      error?: string;
    };
