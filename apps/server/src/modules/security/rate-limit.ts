// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { normalizeIP } from '@fastify/rate-limit';

import type { FastifyRequest } from 'fastify';

export const APPLICATION_RATE_LIMIT_MAX = 1_000;
export const APPLICATION_RATE_LIMIT_WINDOW_MS = 60_000;

function isExemptRequest(request: FastifyRequest): boolean {
  if (request.method === 'OPTIONS') return true;
  return (
    request.method === 'GET' &&
    request.url.split('?', 1)[0] === '/api/deployment/readiness'
  );
}

function directPeerKey(request: FastifyRequest): string {
  const peer = request.socket.remoteAddress;
  return peer ? normalizeIP(peer) : 'unknown-peer';
}

export function createApplicationRateLimitOptions(
  overrides: { max?: number; timeWindow?: number } = {},
) {
  const max = overrides.max ?? APPLICATION_RATE_LIMIT_MAX;
  const timeWindow = overrides.timeWindow ?? APPLICATION_RATE_LIMIT_WINDOW_MS;

  return {
    global: true,
    max,
    timeWindow,
    hook: 'onRequest' as const,
    keyGenerator: directPeerKey,
    allowList: (request: FastifyRequest) => isExemptRequest(request),
    errorResponseBuilder: (
      _request: FastifyRequest,
      context: { statusCode: number; ttl: number },
    ) => {
      const retryAfterSeconds = Math.max(1, Math.ceil(context.ttl / 1_000));
      const body = {
        message: `Too many requests. Try again in ${retryAfterSeconds} seconds.`,
        code: 'RATE_LIMITED',
        details: { retryAfterSeconds },
      };
      Object.defineProperty(body, 'statusCode', {
        value: context.statusCode,
        enumerable: false,
      });
      return body;
    },
    onExceeded: (request: FastifyRequest, key: string) => {
      request.log.warn(
        {
          client: key,
          method: request.method,
          route: request.routeOptions.url,
        },
        'Request rate limit exceeded',
      );
    },
  };
}
