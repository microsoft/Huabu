// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import staticPlugin from '@fastify/static';

import type { FastifyInstance } from 'fastify';

/**
 * Serve the pre-built web application from `root`. Every path that names no
 * file falls back to `index.html`, so client-side routes load the app, except
 * under `/api`: an API path no route serves is a 404 there, not a page.
 * The fallback uses `reply.sendFile`, which the host's own `@fastify/static`
 * registration provides.
 */
export function registerWebShell(app: FastifyInstance, root: string): void {
  app.register(async (shell) => {
    // The application shell is what a browser loads to sign in.
    shell.addHook('onRoute', (route) => {
      route.config = { ...route.config, identity: 'shell' };
    });
    await shell.register(staticPlugin, {
      root,
      prefix: '/',
      decorateReply: false,
    });
  });
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?', 1)[0];
    if (path === '/api' || path.startsWith('/api/'))
      return reply.code(404).send({
        message: `Route ${request.method}:${path} not found`,
      });
    return reply.sendFile('index.html', root);
  });
}
