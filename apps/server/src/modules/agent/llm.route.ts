import {
  llmConfigUpdateSchema,
  llmImageConfigUpdateSchema,
  llmModelsQuerySchema,
  oauthStatusQuerySchema,
} from '@sediment/shared';

import {
  getAvailableProviders,
  getImageConfig,
  getLLMConfig,
  getModelsForProviderLive,
  setImageConfig,
  setLLMConfig,
} from './llm.js';
import {
  logoutOAuth,
  pollDeviceCode,
  startDeviceCodeFlow,
  verifyOAuthCredentials,
} from './oauth.js';
import { isLoopbackRequest } from '../security/peer.js';

import type {
  ApiResult,
  LLMConfig,
  LLMConfigUpdate,
  LLMImageConfig,
  LLMImageConfigUpdate,
  LLMModelsQuery,
  LLMModelsResponse,
  LLMProvidersResponse,
  OAuthDeviceCodeResponse,
  OAuthLogoutResponse,
  OAuthPollResponse,
  OAuthStatusQuery,
  OAuthStatusResponse,
} from '@sediment/shared';
import type { FastifyPluginAsync } from 'fastify';

const llmRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/llm/config — return current provider/model config
  app.get<{ Reply: ApiResult<LLMConfig> }>('/config', async () => {
    return await getLLMConfig();
  });

  // PUT /api/llm/config — update provider/model config
  app.put<{ Body: LLMConfigUpdate; Reply: ApiResult<LLMConfig> }>(
    '/config',
    async (request, reply) => {
      if (!isLoopbackRequest(request)) {
        return reply.status(403).send({
          message: 'Forbidden: LLM settings can only be changed from localhost',
        });
      }

      const parsed = llmConfigUpdateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ message: parsed.error.issues[0]?.message ?? 'Invalid body' });
      }

      const result = await setLLMConfig(parsed.data);
      return reply.send(result);
    },
  );

  // GET /api/llm/image-config — return image-generation config
  app.get<{ Reply: ApiResult<LLMImageConfig> }>('/image-config', async () => {
    return getImageConfig();
  });

  // PUT /api/llm/image-config — update image-generation config
  app.put<{ Body: LLMImageConfigUpdate; Reply: ApiResult<LLMImageConfig> }>(
    '/image-config',
    async (request, reply) => {
      if (!isLoopbackRequest(request)) {
        return reply.status(403).send({
          message: 'Forbidden: LLM settings can only be changed from localhost',
        });
      }

      const parsed = llmImageConfigUpdateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ message: parsed.error.issues[0]?.message ?? 'Invalid body' });
      }

      const result = setImageConfig(parsed.data);
      return reply.send(result);
    },
  );

  // GET /api/llm/providers — list available providers
  app.get<{ Reply: ApiResult<LLMProvidersResponse> }>(
    '/providers',
    async () => {
      return { providers: getAvailableProviders() };
    },
  );

  // GET /api/llm/models — list available models for a provider
  app.get<{
    Querystring: LLMModelsQuery;
    Reply: ApiResult<LLMModelsResponse>;
  }>('/models', async (request, reply) => {
    const parsed = llmModelsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ message: parsed.error.issues[0]?.message ?? 'Invalid query' });
    }

    const models = await getModelsForProviderLive(parsed.data.provider);
    return { provider: parsed.data.provider, models };
  });

  // ── OAuth (GitHub Copilot) ──

  // POST /api/llm/oauth/device-code — start device code flow
  app.post<{ Reply: ApiResult<OAuthDeviceCodeResponse> }>(
    '/oauth/device-code',
    async (request, reply) => {
      if (!isLoopbackRequest(request)) {
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
    },
  );

  // POST /api/llm/oauth/poll — poll for authorization result
  app.post<{ Reply: ApiResult<OAuthPollResponse> }>(
    '/oauth/poll',
    async (request, reply) => {
      if (!isLoopbackRequest(request)) {
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
    },
  );

  // GET /api/llm/oauth/status — check if OAuth credentials exist AND are usable
  app.get<{
    Querystring: OAuthStatusQuery;
    Reply: ApiResult<OAuthStatusResponse>;
  }>('/oauth/status', async (request, reply) => {
    const parsed = oauthStatusQuerySchema.safeParse(request.query);
    const provider = parsed.success ? parsed.data.provider : 'github-copilot';

    // Authoritative check: refreshes the access token if it has expired
    // so the Settings UI never reports "authenticated" while the next
    // agent call would 401. Cost: single network call only when the
    // cached access token is past its expiry.
    const authenticated = await verifyOAuthCredentials(provider);
    return reply.send({ authenticated, provider });
  });

  // POST /api/llm/oauth/logout — clear OAuth credentials
  app.post<{ Reply: ApiResult<OAuthLogoutResponse> }>(
    '/oauth/logout',
    async (request, reply) => {
      if (!isLoopbackRequest(request)) {
        return reply.status(403).send({ message: 'Forbidden' });
      }

      logoutOAuth();
      return reply.send({ ok: true });
    },
  );
};

export default llmRoutes;
