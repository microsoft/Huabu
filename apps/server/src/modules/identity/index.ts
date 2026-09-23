// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createBubbleIdentityService } from './bubble.js';
import { resolveIdentityConfig } from './config.js';
import { createLocalIdentityService } from './local.js';

import type { IdentityService } from './service.js';

export { registerIdentity } from './http.js';
export { getRequestIdentity } from './request.js';
export type { IdentityService, ResolvedIdentity } from './service.js';

export function createIdentityService(
  env: NodeJS.ProcessEnv = process.env,
): IdentityService {
  const config = resolveIdentityConfig(env);
  return config.provider === 'bubble'
    ? createBubbleIdentityService(config.baseUrl)
    : createLocalIdentityService(config);
}
