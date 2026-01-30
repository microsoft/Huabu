import type { SendMessageRequest, SendMessageResponse } from "@sediment/shared";
import type { FastifyPluginAsync } from "fastify";

const chatRoutes: FastifyPluginAsync = async (fastify, _opts): Promise<void> => {
  fastify.post<{ Body: SendMessageRequest, Reply: SendMessageResponse }>('/', async function (request, _reply) {
    const { content } = request.body;
    return {
      messageId: "123",
      reply: `Echo: ${content}`
    };
  });
};

export default chatRoutes;
