import cors from '@fastify/cors';
import { fastify, type FastifyPluginAsync } from 'fastify';

import chatRoutes from './modules/chat/chat.route.js';

export const app = fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
  },
});

// Register CORS
app.register(cors as unknown as FastifyPluginAsync<{ origin: boolean }>, {
  origin: true, // Allow all origins in development, specify domains in production
});

app.register(chatRoutes, { prefix: '/api/chat' });
