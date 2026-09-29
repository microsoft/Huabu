// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createLocalIdentityService } from '../modules/identity/local.js';
import { setRequestIdentity } from '../modules/identity/request.js';
import { isLoopbackRequest } from '../modules/security/peer.js';

import type { FastifyInstance } from 'fastify';

/** Resolve real local identities while leaving rejection to the route under test. */
export function registerLocalTestIdentity(app: FastifyInstance): void {
  const service = createLocalIdentityService();
  app.addHook('onRequest', async (request) => {
    const identity = await service.authenticate({
      authorization: request.headers.authorization,
      loopback: isLoopbackRequest(request),
    });
    if (identity) setRequestIdentity(request, identity);
  });
}
