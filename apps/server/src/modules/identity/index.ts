// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { resolveIdentityConfig } from './config.js';
import { createLocalIdentityService } from './local.js';
import { openPostgresWorkspacePreferences } from './preferences.js';
import { storageResourceDirectory } from './resources.js';

import type { IdentityService, ResourceDirectory } from './service.js';
import type { BubbleAuthConfig } from '@octostaff/bubble';
import type { FastifyPluginAsync } from 'fastify';

export { registerIdentity } from './http.js';
export { getRequestIdentity } from './request.js';
export type {
  HuabuResource,
  IdentityService,
  ResolvedIdentity,
} from './service.js';

/** The selected provider, plus Bubble's own API when Bubble provides identity. */
export function createIdentity(
  env: NodeJS.ProcessEnv = process.env,
  resources: ResourceDirectory = storageResourceDirectory,
): {
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
      preferences: await openPostgresWorkspacePreferences(postgresUrl),
      resources,
    });
  }
  return {
    service: {
      provider: 'bubble',
      challenge: 'Bearer realm="Huabu"',
      ...(config.providerSignOut ? { providerSignOut: true } : {}),
      authenticate: async (credentials) =>
        (await (opening ??= open())).service.authenticate(credentials),
      // Present from the start so routes can tell Bubble mode by it; each call
      // opens Bubble on demand like every other member here.
      people: {
        list: async () => (await (opening ??= open())).service.people!.list(),
        setMember: async (...args) =>
          (await (opening ??= open())).service.people!.setMember(...args),
        setWorkspaceRole: async (...args) =>
          (await (opening ??= open())).service.people!.setWorkspaceRole(
            ...args,
          ),
      },
      selectWorkspace: async (identity) =>
        (await (opening ??= open())).service.selectWorkspace!(identity),
      chooseWorkspace: async (identity, workspaceId) =>
        (await (opening ??= open())).service.chooseWorkspace!(
          identity,
          workspaceId,
        ),
    },
    bubble: async (app, options) =>
      (await (opening ??= open())).plugin(app, options),
  };
}
