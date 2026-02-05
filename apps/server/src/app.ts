import cors from '@fastify/cors';
import Fastify from 'fastify';

import chatRoutes from './modules/chat/chat.route.js';

// @ts-expect-error - Fastify type definition issue
export const app = Fastify();

// Register CORS
app.register(cors, {
  origin: true, // Allow all origins in development, specify domains in production
});

app.register(chatRoutes, { prefix: '/api/chat' });
