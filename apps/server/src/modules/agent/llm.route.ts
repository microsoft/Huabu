import { z } from 'zod';

import {
  getAvailableProviders,
  getLLMConfig,
  getModelsForProvider,
  setLLMConfig,
} from './llm.js';
import {
  hasOAuthCredentials,
  logoutOAuth,
  pollDeviceCode,
  startDeviceCodeFlow,
} from './oauth.js';

import type { FastifyPluginAsync } from 'fastify';

/**
 * Guard: only allow requests from localhost.
 */
function isLocalhost(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

const llmRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/llm/config — return current provider/model config
  app.get('/config', async () => {
    return getLLMConfig();
  });

  // PUT /api/llm/config — update provider/model config
  app.put('/config', async (request, reply) => {
    if (!isLocalhost(request.ip)) {
      return reply.status(403).send({
        message: 'Forbidden: LLM settings can only be changed from localhost',
      });
    }

    const schema = z.object({
      provider: z.string().min(1, 'Provider is required'),
      model: z.string().min(1, 'Model is required'),
      apiKey: z.string().optional(),
      baseUrl: z.string().optional(),
    });

    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ message: parsed.error.issues[0]?.message });
    }

    const result = setLLMConfig(parsed.data);
    return reply.send(result);
  });

  // GET /api/llm/providers — list available providers
  app.get('/providers', async () => {
    return { providers: getAvailableProviders() };
  });

  // GET /api/llm/models — list available models for a provider
  app.get('/models', async (request, reply) => {
    const schema = z.object({
      provider: z.string().min(1, 'Provider query param is required'),
    });

    const parsed = schema.safeParse(request.query);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ message: parsed.error.issues[0]?.message });
    }

    const models = getModelsForProvider(parsed.data.provider);
    return { provider: parsed.data.provider, models };
  });

  // ── OAuth (GitHub Copilot) ──

  // POST /api/llm/oauth/device-code — start device code flow
  app.post('/oauth/device-code', async (request, reply) => {
    if (!isLocalhost(request.ip)) {
      return reply.status(403).send({ message: 'Forbidden' });
    }

    try {
      const result = await startDeviceCodeFlow();
      return reply.send(result);
    } catch (err) {
      return reply.status(500).send({
        message: err instanceof Error ? err.message : 'OAuth flow failed',
      });
    }
  });

  // POST /api/llm/oauth/poll — poll for authorization result
  app.post('/oauth/poll', async (request, reply) => {
    if (!isLocalhost(request.ip)) {
      return reply.status(403).send({ message: 'Forbidden' });
    }

    try {
      const status = await pollDeviceCode();
      return reply.send({ status });
    } catch (err) {
      return reply.send({
        status: 'error',
        error: err instanceof Error ? err.message : 'Poll failed',
      });
    }
  });

  // GET /api/llm/oauth/status — check if OAuth credentials exist
  app.get('/oauth/status', async (request, reply) => {
    const schema = z.object({
      provider: z.string().min(1),
    });

    const parsed = schema.safeParse(request.query);
    const provider = parsed.success ? parsed.data.provider : 'github-copilot';

    const authenticated = hasOAuthCredentials(provider);
    return reply.send({ authenticated, provider });
  });

  // POST /api/llm/oauth/logout — clear OAuth credentials
  app.post('/oauth/logout', async (request, reply) => {
    if (!isLocalhost(request.ip)) {
      return reply.status(403).send({ message: 'Forbidden' });
    }

    logoutOAuth();
    return reply.send({ ok: true });
  });
};

export default llmRoutes;
