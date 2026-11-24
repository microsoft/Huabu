// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { markAgentCredential } from '../modules/identity/request.js';

import type { FastifyInstance } from 'fastify';

/**
 * Headers of a test request that arrives the way an agent's does. A suite
 * that mounts routes without the identity layer has no machine token to
 * present, so this stands in for the admission that would have recognised
 * one (`registerIdentity` → `markAgentCredential`).
 */
export const AGENT_CREDENTIAL = { 'x-test-credential': 'agent' } as const;

/** Mark requests that carry `AGENT_CREDENTIAL` as made with an agent credential. */
export function registerTestAgentCredential(app: FastifyInstance): void {
  app.addHook('onRequest', async (request) => {
    if (request.headers['x-test-credential'] === 'agent')
      markAgentCredential(request);
  });
}
