// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  conversationTitleParamsSchema,
  conversationTitleQuerySchema,
  queryConversationTitlesBodySchema,
  setConversationTitleBodySchema,
} from '@huabu/shared';

import { conversationTitleService } from './conversation-title.service.js';

import type { ConversationTitleService } from './conversation-title.service.js';
import type {
  ApiResult,
  ConversationTitle,
  QueryConversationTitlesResponse,
} from '@huabu/shared';
import type { FastifyPluginAsync } from 'fastify';

export function createConversationTitleRoutes(
  service: Pick<
    ConversationTitleService,
    'query' | 'setUserTitle'
  > = conversationTitleService,
): FastifyPluginAsync {
  return async (fastify) => {
    fastify.post<{ Reply: ApiResult<QueryConversationTitlesResponse> }>(
      '/threads/titles/query',
      async (request, reply) => {
        const body = queryConversationTitlesBodySchema.safeParse(request.body);
        if (!body.success)
          return reply
            .code(400)
            .send({ message: body.error.issues[0]?.message ?? 'Invalid body' });
        return reply.send(
          await service.query(body.data.canvasId, body.data.threadIds),
        );
      },
    );
    fastify.put<{ Reply: ApiResult<ConversationTitle> }>(
      '/threads/:threadId/title',
      async (request, reply) => {
        const params = conversationTitleParamsSchema.safeParse(request.params);
        const query = conversationTitleQuerySchema.safeParse(request.query);
        const body = setConversationTitleBodySchema.safeParse(request.body);
        if (!params.success || !query.success || !body.success)
          return reply
            .code(400)
            .send({ message: 'Invalid conversation title request' });
        const result = await service.setUserTitle(
          query.data.canvasId,
          params.data.threadId,
          body.data.title,
        );
        if (!result)
          return reply.code(404).send({
            message: 'Conversation has no durable thread yet',
            code: 'thread_not_found',
          });
        return reply.send(result);
      },
    );
  };
}

export default createConversationTitleRoutes();
