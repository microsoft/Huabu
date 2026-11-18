// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { z } from 'zod';

import type { ChatHistoryItem } from '../agent/chat.js';

export const historyDetailLevelSchema = z.enum(['full', 'summary']);
export type HistoryDetailLevel = z.infer<typeof historyDetailLevelSchema>;

export const toolDetailSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('inline'), turnRef: z.string().min(1) }),
  z.object({
    state: z.literal('deferred'),
    turnRef: z.string().min(1),
    summary: z.object({
      count: z.number().int().nonnegative().optional(),
      detailCount: z.number().int().nonnegative().optional(),
      nodeCount: z.number().int().nonnegative().optional(),
      imageCount: z.number().int().nonnegative().optional(),
      referenceCount: z.number().int().nonnegative().optional(),
      changedPaths: z.array(z.string()).optional(),
    }),
  }),
]);
export type ToolDetail = z.infer<typeof toolDetailSchema>;

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
  detailLevel: historyDetailLevelSchema.optional(),
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

export const agentHistoryTurnParamsSchema = agentHistoryPageParamsSchema.extend(
  {
    turnRef: z.string().min(1).max(4096),
  },
);
export const agentHistoryTurnQuerySchema = z.object({
  canvasId: z.string().trim().min(1),
});
export type AgentHistoryTurnParams = z.infer<
  typeof agentHistoryTurnParamsSchema
>;
export type AgentHistoryTurnQuery = z.infer<typeof agentHistoryTurnQuerySchema>;
export const agentHistoryTurnResponseSchema = z.object({
  threadId: z.string(),
  turnRef: z.string(),
  messages: z.array(z.custom<ChatHistoryItem>()),
});
export type AgentHistoryTurnResponse = z.infer<
  typeof agentHistoryTurnResponseSchema
>;
