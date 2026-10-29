// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { HuabuResource, ResolvedIdentity } from './service.js';
import type { FastifyRequest } from 'fastify';

const identities = new WeakMap<FastifyRequest, ResolvedIdentity>();
const authorizations = new WeakMap<
  FastifyRequest,
  Array<{ level: 'read' | 'write'; resource: HuabuResource }>
>();

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

/** Record a resource access the request was granted, to recheck while it lasts. */
export function recordRequestAuthorization(
  request: FastifyRequest,
  level: 'read' | 'write',
  resource: HuabuResource,
): void {
  const granted = authorizations.get(request) ?? [];
  granted.push({ level, resource });
  authorizations.set(request, granted);
}

export function getRequestAuthorizations(
  request: FastifyRequest,
): ReadonlyArray<{ level: 'read' | 'write'; resource: HuabuResource }> {
  return authorizations.get(request) ?? [];
}
