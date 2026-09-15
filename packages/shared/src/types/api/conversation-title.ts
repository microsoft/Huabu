// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { z } from 'zod';

// IDs address a single Canvas namespace or thread, never a filesystem path.
const titleScopeIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  // Reject control characters as well as path separators at the HTTP boundary.
  // eslint-disable-next-line no-control-regex
  .regex(/^[^/\\\s\u0000-\u001f]+$/)
  .refine((value) => value !== '.' && value !== '..', 'Invalid identifier');

export const conversationTitleSchema = z.object({
  title: z.string().nullable(),
  source: z.enum(['user', 'acp', 'generated', 'fallback']).nullable(),
});
export type ConversationTitle = z.infer<typeof conversationTitleSchema>;

export const queryConversationTitlesBodySchema = z.object({
  canvasId: titleScopeIdSchema,
  threadIds: z.array(titleScopeIdSchema).max(100),
});
export type QueryConversationTitlesBody = z.infer<
  typeof queryConversationTitlesBodySchema
>;

export const queryConversationTitlesResponseSchema = z.object({
  titles: z.record(z.string(), conversationTitleSchema),
});
export type QueryConversationTitlesResponse = z.infer<
  typeof queryConversationTitlesResponseSchema
>;

export const setConversationTitleBodySchema = z.object({
  title: z.string().trim().min(1).max(120),
});
export type SetConversationTitleBody = z.infer<
  typeof setConversationTitleBodySchema
>;

export const conversationTitleParamsSchema = z.object({
  threadId: titleScopeIdSchema,
});
export const conversationTitleQuerySchema = z.object({
  canvasId: titleScopeIdSchema,
});
