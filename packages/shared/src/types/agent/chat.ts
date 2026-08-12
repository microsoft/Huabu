// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { AssistantHistoryPart } from './assistant-parts.js';

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
 * A per-sketch-node partial stroke selection recorded on a chat message
 * — the strokes the user lassoed (a KEEP list of stable `SketchStroke.id`s)
 * when they sent the turn. Lets the UI show “N strokes” and re-highlight
 * just those strokes on hover. Absent = the whole node was in scope.
 */
export interface SelectedStrokeSubset {
  nodeId: string;
  strokeIds: string[];
}

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
      /**
       * Partial stroke selections (per sketch node) that were sent as
       * context — the lassoed stroke subset. Coexists with
       * `selectedNodeIds` (the node also appears there). Absent when no
       * partial stroke selection was active.
       */
      selectedStrokeIds?: SelectedStrokeSubset[];
      /**
       * Skill ids the user explicitly invoked via leading `/<id>`
       * tokens. Preserved across reload so the chat bubble can render
       * the same `/skill` chips the user typed (the message body
       * itself has those tokens stripped — see
       * `parseSlashInvocations`).
       */
      invokedSkills?: string[];
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
    };

/** Response from GET /api/chat/history/:threadId */
export interface ChatHistoryResponse {
  threadId: string;
  messages: ChatHistoryItem[];
}
