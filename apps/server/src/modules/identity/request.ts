// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { ResolvedIdentity } from './service.js';
import type { FastifyRequest } from 'fastify';

const identities = new WeakMap<FastifyRequest, ResolvedIdentity>();

export function setRequestIdentity(
  request: FastifyRequest,
  identity: ResolvedIdentity,
): void {
  identities.set(request, identity);
}

/** Transport-resolved identity, never a caller-supplied principal header/body. */
export function getRequestIdentity(
  request: FastifyRequest,
): ResolvedIdentity | undefined {
  return identities.get(request);
}
