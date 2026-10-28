// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { timingSafeEqual } from 'node:crypto';

import { openPersonalSettings, useCaller } from './personal-settings.js';
import {
  getRequestAuthorizations,
  setRequestWorkspaceChooser,
  getRequestIdentity,
  setRequestIdentity,
} from './request.js';
import { IdentityError, UNRESTRICTED_ACCESS } from './service.js';
import { isPublicRfsSkillBootstrapRequest } from '../remote_fs/public-skill.js';
import { isLoopbackRequest } from '../security/peer.js';
import {
  fillWorkspaceScope,
  openWorkspaceScope,
} from '../workspace/context.js';

import type { IdentityCredentials, IdentityService } from './service.js';
import type { IdentityResponse } from '@huabu/shared';
import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * `route-owned`: set by a mounted service that authenticates its own
     * callers. `shell`: the web application itself, which a browser must load
     * before it can sign in to Bubble; local mode still guards it.
     */
    identity?: 'route-owned' | 'shell';
  }
}

const SESSION_PATH = '/api/identity/session';
const SESSION_COOKIE = 'huabu_session';

/** The Bearer credential a browser session carries, if it has one. */
function sessionAuthorization(cookieHeader: string | undefined) {
  for (const part of cookieHeader?.split(';') ?? []) {
    const [name, ...value] = part.trim().split('=');
    if (name === SESSION_COOKIE && value.length)
      return `Bearer ${decodeURIComponent(value.join('='))}`;
  }
  return undefined;
}

function sessionCookie(value: string, secure: boolean, maxAge?: number) {
  return [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    ...(secure ? ['Secure'] : []),
    ...(maxAge === undefined ? [] : [`Max-Age=${maxAge}`]),
  ].join('; ');
}

/** Install on the host scope before routes; machine credentials stay host-owned. */
export function registerIdentity(
  app: FastifyInstance,
  options: {
    service: IdentityService;
    getConnectionToken: () => string | undefined;
    /** The Server is reached over HTTPS, as its configured public origin says. */
    secureOrigin?: boolean;
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
  // In Bubble mode every request runs in its caller's own Workspace. The slot
  // must wrap the rest of the lifecycle, which only a callback hook can do;
  // admission fills it below once it knows who is calling.
  if (service.provider === 'bubble') {
    app.addHook('onRequest', (_request, _reply, done) =>
      openWorkspaceScope(done),
    );
    // Likewise each member's settings, model keys and credentials are their own.
    app.addHook('onRequest', (_request, _reply, done) =>
      openPersonalSettings(done),
    );
  }
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?', 1)[0];
    const identityRoute = path === '/api/identity' || path === SESSION_PATH;
    if (identityRoute) reply.header('Cache-Control', 'no-store');
    if (request.method === 'OPTIONS') return;
    // Matched by route, not URL, so no path spelling can borrow the exemption.
    if (request.routeOptions.config?.identity === 'route-owned') return;
    // The application shell holds no data, so Bubble mode serves it, with its
    // index.html fallback, to a browser that has yet to sign in.
    if (
      service.provider === 'bubble' &&
      request.routeOptions.config?.identity === 'shell'
    )
      return;
    // A browser cannot attach a header to an image, frame or download, so in
    // Bubble mode its session cookie carries the same Bearer credential.
    const authorization =
      request.headers.authorization ??
      (service.provider === 'bubble'
        ? sessionAuthorization(request.headers.cookie)
        : undefined);
    if (
      isPublicRfsSkillBootstrapRequest({
        method: request.method,
        url: request.url,
        authorization,
      })
    )
      return;

    // Existing machine reachback remains available. Whether it is also an
    // owner is the provider's call: local mode keeps its loopback rule, and in
    // Bubble mode a daemon is never a human owner.
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
        member: true,
        owner: service.machineOwner?.(isLoopbackRequest(request)) ?? false,
        access: UNRESTRICTED_ACCESS,
      });
      return;
    }

    const credentials: IdentityCredentials = {
      authorization,
      loopback: isLoopbackRequest(request),
      header: (name) => {
        const value = request.headers[name];
        return Array.isArray(value) ? value[0] : value;
      },
    };
    // Without a login the RFS surface still requires the machine token.
    // Basic-authenticated owners retain their current access.
    if (service.credentialFree && request.url.startsWith('/api/rfs/'))
      return reply.code(401).send({
        message: 'Authentication required',
        code: 'IDENTITY_REQUIRED',
      });
    try {
      const identity = await service.authenticate(credentials);
      if (!identity) {
        return reply
          .header('WWW-Authenticate', service.challenge)
          .code(401)
          .send({
            message: 'Authentication required',
            code: 'IDENTITY_REQUIRED',
          });
      }
      setRequestIdentity(request, identity);
      // A login alone is not Huabu access. Without it a principal may inspect
      // only their own identity and session; routes that need an owner check
      // that themselves.
      if (!identity.member && !identityRoute) {
        return reply.code(403).send({
          message: 'Huabu access required',
          code: 'ACCESS_REQUIRED',
        });
      }
      // A member's first request, `GET /api/identity` after sign-in included,
      // is also where their personal Workspace is created.
      if (identity.member && service.selectWorkspace) useCaller(identity);
      if (identity.member && service.selectWorkspace) {
        const scope = await service.selectWorkspace(identity);
        if (scope) fillWorkspaceScope(scope);
        const { chooseWorkspace } = service;
        if (chooseWorkspace)
          setRequestWorkspaceChooser(
            request,
            async (workspaceId) =>
              (await chooseWorkspace(identity, workspaceId)) !== null,
          );
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
        // Every Space the request was let into must still be open to it.
        const stillAuthorized = async (current: typeof identity) => {
          for (const { level, resource } of getRequestAuthorizations(request))
            if (!(await current.access.can(level, resource))) return false;
          return true;
        };
        const timer = setInterval(() => {
          if (closed || checking) return;
          checking = true;
          void service
            .authenticate(credentials)
            .then(async (current) => {
              if (
                !closed &&
                (!current ||
                  current.principal.principalId !==
                    identity.principal.principalId ||
                  (!identityRoute &&
                    (!current.member ||
                      current.owner !== identity.owner ||
                      !(await stillAuthorized(current)))))
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
      const { principal, member, owner } = identity;
      return { provider: service.provider, principal, member, owner };
    },
  );

  if (service.provider !== 'bubble') return;
  // Behind a TLS-terminating proxy the listener itself sees plain HTTP.
  const secure = (request: { protocol: string }) =>
    options.secureOrigin === true || request.protocol === 'https';
  // The SPA hands over the credential it obtained once; Bubble validates it on
  // every request, so the cookie is a carrier and never a session of its own.
  app.post(SESSION_PATH, async (request, reply) => {
    const header = request.headers.authorization;
    const token = header?.match(/^Bearer\s+(\S+)$/i)?.[1];
    // Only a credential Bubble accepts becomes a session, never the cookie
    // itself or the machine token.
    if (
      !token ||
      !(await service.authenticate({ authorization: header, loopback: false }))
    ) {
      return reply.code(400).send({
        message: 'A Bubble Bearer credential is required',
        code: 'IDENTITY_REQUIRED',
      });
    }
    return reply
      .header(
        'Set-Cookie',
        sessionCookie(encodeURIComponent(token), secure(request)),
      )
      .code(204)
      .send();
  });
  // Ending a session needs no valid credential: an expired one must still go.
  app.delete(
    SESSION_PATH,
    { config: { identity: 'route-owned' } },
    async (request, reply) =>
      reply
        .header('Set-Cookie', sessionCookie('', secure(request), 0))
        .code(204)
        .send(),
  );
}
