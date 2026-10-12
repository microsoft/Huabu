// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { resolveIdentityConfig } from './config.js';
import { createLocalIdentityService } from './local.js';

import type { IdentityService } from './service.js';
import type { BubbleAuthConfig } from '@octostaff/bubble';
import type { FastifyPluginAsync } from 'fastify';

export { registerIdentity } from './http.js';
export { getRequestIdentity } from './request.js';
export type { IdentityService, ResolvedIdentity } from './service.js';

/** The selected provider, plus Bubble's own API when Bubble provides identity. */
export function createIdentity(env: NodeJS.ProcessEnv = process.env): {
  service: IdentityService;
  bubble?: FastifyPluginAsync;
} {
  const config = resolveIdentityConfig(env);
  if (config.provider === 'local')
    return { service: createLocalIdentityService(config) };

  // Bubble is loaded and started only when a service needs it. Registering
  // the plugin opens it during startup, so a bad configuration fails there.
  const { authenticators, owner, postgresUrl } = config;
  let opening: ReturnType<typeof open> | undefined;
  async function open() {
    const bubble = await import('./bubble.js');
    return bubble.openBubbleIdentity({
      authenticator: authenticators as BubbleAuthConfig,
      owner,
      store: await bubble.openBubblePostgresStore(postgresUrl),
    });
  }
  return {
    service: {
      provider: 'bubble',
      challenge: 'Bearer realm="Huabu"',
      authenticate: async (credentials) =>
        (await (opening ??= open())).service.authenticate(credentials),
    },
    bubble: async (app, options) =>
      (await (opening ??= open())).plugin(app, options),
  };
}
