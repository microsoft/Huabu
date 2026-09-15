// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { apiFetch } from './_client';
import { routes } from './_routes';

import type {
  ConversationTitle,
  QueryConversationTitlesBody,
  QueryConversationTitlesResponse,
  SetConversationTitleBody,
} from '@huabu/shared';

export function queryConversationTitles(body: QueryConversationTitlesBody) {
  return apiFetch<QueryConversationTitlesResponse>(routes.conversationTitles, {
    method: 'POST',
    json: body,
    fallbackMessage: 'Failed to load conversation titles',
  });
}

export function setConversationTitle(
  canvasId: string,
  threadId: string,
  body: SetConversationTitleBody,
) {
  return apiFetch<ConversationTitle>(
    routes.conversationTitle(threadId, canvasId),
    {
      method: 'PUT',
      json: body,
      fallbackMessage: 'Failed to save conversation title',
    },
  );
}
