// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { timingSafeEqual } from 'node:crypto';

import { getRequestIdentity, setRequestIdentity } from './request.js';
import { IdentityError } from './service.js';
import { isPublicRfsSkillBootstrapRequest } from '../remote_fs/public-skill.js';
import { isLoopbackRequest } from '../security/peer.js';

import type { IdentityService } from './service.js';
import type { IdentityResponse } from '@huabu/shared';
import type { FastifyInstance } from 'fastify';

/** Install on the host scope before routes; machine credentials stay host-owned. */
export function registerIdentity(
  app: FastifyInstance,
  options: {
    service: IdentityService;
    getConnectionToken: () => string | undefined;
    /** Bounded revocation for long-lived HTTP responses such as canvas SSE. */
    revalidationIntervalMs?: number;
  },
): void {
  const { service } = options;
  const interval = options.revalidationIntervalMs ?? 30_000;
  if (!Number.isFinite(interval) || interval <= 0) {
    throw new Error('Identity revalidation interval must be positive');
  }
  const activeResponses = new Set<() => void>();
  app.addHook('preClose', async () => {
    for (const close of activeResponses) close();
  });
  app.addHook('onRequest', async (request, reply) => {
    const identityRoute = request.url.split('?', 1)[0] === '/api/identity';
    if (identityRoute) reply.header('Cache-Control', 'no-store');
    if (request.method === 'OPTIONS') return;
    const authorization = request.headers.authorization;
    if (
      isPublicRfsSkillBootstrapRequest({
        method: request.method,
        url: request.url,
        authorization,
      })
    )
      return;

    // Existing machine reachback remains available, but even a loopback daemon
    // is not a human owner and may not change credentials or configuration.
    const machineToken = options.getConnectionToken();
    const supplied = Buffer.from(authorization ?? '');
    const expected = machineToken
      ? Buffer.from(`Bearer ${machineToken}`)
      : undefined;
    if (
      expected &&
      supplied.length === expected.length &&
      timingSafeEqual(supplied, expected)
    ) {
      setRequestIdentity(request, {
        principal: { principalId: 'huabu-agentlet', kind: 'bot' },
        owner: false,
      });
      return;
    }

    try {
      // In the zero-config local mode the RFS surface still requires its
      // machine token. Basic-authenticated owners retain their current access.
      const identity = await service.authenticate({
        authorization,
        loopback: isLoopbackRequest(request),
      });
      if (
        !identity ||
        (service.provider === 'local' &&
          !authorization &&
          request.url.startsWith('/api/rfs/'))
      ) {
        return reply
          .header('WWW-Authenticate', service.challenge)
          .code(401)
          .send({
            message: 'Authentication required',
            code: 'IDENTITY_REQUIRED',
          });
      }
      setRequestIdentity(request, identity);
      // Until Space permissions exist, a Bubble login alone must not expose
      // Huabu's shared Workspace. Non-owners may inspect only their own identity.
      if (
        service.provider === 'bubble' &&
        !identity.owner &&
        !(['GET', 'HEAD'].includes(request.method) && identityRoute)
      ) {
        return reply.code(403).send({
          message: 'Huabu owner access required',
          code: 'OWNER_REQUIRED',
        });
      }
      if (
        service.provider === 'bubble' &&
        !reply.raw.destroyed &&
        !reply.raw.writableEnded
      ) {
        let checking = false;
        let closed = false;
        const close = () => {
          cleanup();
          reply.raw.end();
        };
        const cleanup = () => {
          closed = true;
          clearInterval(timer);
          activeResponses.delete(close);
        };
        const timer = setInterval(() => {
          if (closed || checking) return;
          checking = true;
          void service
            .authenticate({
              authorization,
              loopback: isLoopbackRequest(request),
            })
            .then((current) => {
              if (
                !closed &&
                (!current ||
                  current.principal.principalId !==
                    identity.principal.principalId ||
                  (!identityRoute && !current.owner))
              )
                close();
            })
            .catch(() => {
              if (!closed) close();
            })
            .finally(() => {
              checking = false;
            });
        }, interval);
        timer.unref();
        activeResponses.add(close);
        reply.raw.once('finish', cleanup);
        reply.raw.once('close', cleanup);
      }
    } catch (error) {
      if (!(error instanceof IdentityError)) throw error;
      return reply
        .code(error.statusCode)
        .send({ message: error.message, code: error.code });
    }
  });
  app.get<{ Reply: IdentityResponse }>(
    '/api/identity',
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const identity = getRequestIdentity(request);
      if (!identity)
        throw new Error('Identity admission did not resolve a principal');
      return { provider: service.provider, ...identity };
    },
  );
}
