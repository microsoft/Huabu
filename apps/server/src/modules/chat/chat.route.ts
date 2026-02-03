import { HumanMessage } from '@langchain/core/messages';

import { createGraph } from '../agent/graph.js';

import type { SendMessageRequest, SendMessageResponse } from '@sediment/shared';
import type { FastifyPluginAsync } from 'fastify';

const chatRoutes: FastifyPluginAsync = async (
  fastify,
  _opts,
): Promise<void> => {
  // Compile the graph once
  const agent = createGraph();

  fastify.post<{ Body: SendMessageRequest; Reply: SendMessageResponse }>(
    '/',
    async function (request, reply) {
      const { content } = request.body;

      // SSE Headers
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      try {
        const inputs = {
          messages: [new HumanMessage(content)],
        };

        const stream = await agent.stream(inputs);

        for await (const chunk of stream) {
          const nodeName = Object.keys(chunk)[0];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const result = (chunk as Record<string, any>)[nodeName];

          if (result && result.messages && Array.isArray(result.messages)) {
            const lastMessage = result.messages[result.messages.length - 1];
            // Normalize message
            // Handle LangChain message objects vs serialized
            const role =
              lastMessage._getType?.() === 'human' ||
              lastMessage.constructor?.name === 'HumanMessage'
                ? 'user'
                : 'assistant';

            const content =
              typeof lastMessage.content === 'string'
                ? lastMessage.content
                : JSON.stringify(lastMessage.content || '');

            const event = `event: update\ndata: ${JSON.stringify({
              node: nodeName,
              message: { role, content },
            })}\n\n`;
            reply.raw.write(event);
          }
        }

        reply.raw.write(`event: end\ndata: {}\n\n`);
      } catch (error) {
        request.log.error(error);
        const errorMsg =
          error instanceof Error ? error.message : 'Internal Error';
        reply.raw.write(
          `event: error\ndata: ${JSON.stringify({ message: errorMsg })}\n\n`,
        );
      } finally {
        reply.raw.end();
      }
    },
  );
};

export default chatRoutes;
