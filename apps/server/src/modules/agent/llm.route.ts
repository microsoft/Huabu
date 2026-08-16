// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  llmConfigUpdateSchema,
  llmImageConfigUpdateSchema,
  llmModelsQuerySchema,
  llmUtilityConfigUpdateSchema,
  oauthProviderBodySchema,
  oauthStatusQuerySchema,
} from '@huabu/shared';

import {
  getAvailableProviders,
  getImageConfig,
  getLLMConfig,
  getModelsForProviderLive,
  getUtilityConfig,
  setImageConfig,
  setLLMConfig,
  setUtilityConfig,
} from './llm.js';
import {
  logoutOAuth,
  pollDeviceCode,
  startDeviceCodeFlow,
  verifyOAuthCredentials,
} from './oauth.js';
import { getRootErrorMessage } from '../../utils/error-message.js';
import { isOwnerRequest } from '../security/owner.js';

import type {
  ApiResult,
  LLMConfig,
  LLMConfigUpdate,
  LLMImageConfig,
  LLMImageConfigUpdate,
  LLMModelsQuery,
  LLMModelsResponse,
  LLMProvidersResponse,
  LLMUtilityConfig,
  LLMUtilityConfigUpdate,
  OAuthDeviceCodeResponse,
  OAuthLogoutResponse,
  OAuthPollResponse,
  OAuthProviderBody,
  OAuthStatusQuery,
  OAuthStatusResponse,
} from '@huabu/shared';
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
      if (!isOwnerRequest(request)) {
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
      if (!isOwnerRequest(request)) {
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

      const result = await setImageConfig(parsed.data);
      return reply.send(result);
    },
  );

  // GET /api/llm/utility-config — return utility-tier model config
  app.get<{ Reply: ApiResult<LLMUtilityConfig> }>(
    '/utility-config',
    async () => {
      return getUtilityConfig();
    },
  );

  // PUT /api/llm/utility-config — update utility-tier model config
  app.put<{ Body: LLMUtilityConfigUpdate; Reply: ApiResult<LLMUtilityConfig> }>(
    '/utility-config',
    async (request, reply) => {
      if (!isOwnerRequest(request)) {
        return reply.status(403).send({
          message: 'Forbidden: LLM settings can only be changed from localhost',
        });
      }

      const parsed = llmUtilityConfigUpdateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ message: parsed.error.issues[0]?.message ?? 'Invalid body' });
      }

      const result = await setUtilityConfig(parsed.data);
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

  // ── OAuth (GitHub Copilot, OpenAI Codex) ──

  // POST /api/llm/oauth/device-code — start device code flow
  app.post<{
    Body: OAuthProviderBody;
    Reply: ApiResult<OAuthDeviceCodeResponse>;
  }>('/oauth/device-code', async (request, reply) => {
    if (!isOwnerRequest(request)) {
      return reply.status(403).send({ message: 'Forbidden' });
    }

    const parsed = oauthProviderBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ message: parsed.error.issues[0]?.message ?? 'Invalid body' });
    }
    const provider = parsed.data.provider;
    try {
      const result = await startDeviceCodeFlow(provider);
      return reply.send(result);
    } catch (err) {
      return reply.status(500).send({
        message: getRootErrorMessage(err, 'OAuth flow failed'),
      });
    }
  });

  // POST /api/llm/oauth/poll — poll for authorization result
  app.post<{
    Body: OAuthProviderBody;
    Reply: ApiResult<OAuthPollResponse>;
  }>('/oauth/poll', async (request, reply) => {
    if (!isOwnerRequest(request)) {
      return reply.status(403).send({ message: 'Forbidden' });
    }

    const parsed = oauthProviderBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ message: parsed.error.issues[0]?.message ?? 'Invalid body' });
    }
    const provider = parsed.data.provider;
    try {
      const status = await pollDeviceCode(provider);
      return reply.send({ status });
    } catch (err) {
      return reply.send({
        status: 'error',
        error: getRootErrorMessage(err, 'Poll failed'),
      });
    }
  });

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
  app.post<{
    Body: OAuthProviderBody;
    Reply: ApiResult<OAuthLogoutResponse>;
  }>('/oauth/logout', async (request, reply) => {
    if (!isOwnerRequest(request)) {
      return reply.status(403).send({ message: 'Forbidden' });
    }

    const parsed = oauthProviderBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ message: parsed.error.issues[0]?.message ?? 'Invalid body' });
    }
    const provider = parsed.data.provider;
    await logoutOAuth(provider);
    return reply.send({ ok: true });
  });
};

export default llmRoutes;
