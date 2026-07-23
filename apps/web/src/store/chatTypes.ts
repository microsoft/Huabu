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
  IntentCandidate,
  SelectedStrokeSubset,
} from '@sediment/shared';

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
      /**
       * Per-sketch-node partial stroke selections (lassoed subset) sent
       * as context. Coexists with `selectedNodeIds` (the node also
       * appears there). Absent when no partial stroke selection.
       */
      selectedStrokeIds?: SelectedStrokeSubset[];
      /**
       * Skill ids the user explicitly invoked via leading `/<id>`
       * tokens in the chat input. The tokens themselves are stripped
       * from `content` by `parseSlashInvocations` before send — this
       * field lets the bubble re-render them as styled chips so the
       * invocation stays visible in the conversation history.
       */
      invokedSkills?: string[];
    }
  | {
      id: string;
      role: 'assistant';
      segments: AssistantSegment[];
      /** Image/file attachments included with this message. */
      attachments?: ChatAttachment[];
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
    };
