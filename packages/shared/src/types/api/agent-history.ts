// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { z } from 'zod';

import type { ChatHistoryItem } from '../agent/chat.js';

export const agentHistoryPageParamsSchema = z.object({
  threadId: z.string().trim().min(1),
});
export type AgentHistoryPageParams = z.infer<
  typeof agentHistoryPageParamsSchema
>;

export const agentHistoryPageQuerySchema = z.object({
  canvasId: z.string().trim().min(1),
  limit: z.coerce.number().int().min(1).max(20),
  before: z.string().trim().min(1).max(4096).optional(),
});
export type AgentHistoryPageQuery = z.infer<typeof agentHistoryPageQuerySchema>;

export interface AgentHistoryDisplayTurn {
  /** Opaque, stable identity for replacing or deduplicating this whole group. */
  id: string;
  /** All user/assistant/status messages in chronological order. */
  messages: ChatHistoryItem[];
  /** True for the read-time Tier-1 projection; replace this group on refresh. */
  active?: true;
  /** First message projected from Tier 1 when it joins a persisted group. */
  activeMessageStart?: number;
}

export interface AgentHistoryPageResponse {
  threadId: string;
  turns: AgentHistoryDisplayTurn[];
  /** Exclusive cursor for the immediately older page. */
  before?: string;
  hasMore: boolean;
}
