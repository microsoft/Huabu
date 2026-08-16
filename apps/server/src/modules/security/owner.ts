// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { isLoopbackRequest } from './peer.js';

import type { FastifyRequest } from 'fastify';

const basicAuthenticatedRequests = new WeakSet<FastifyRequest>();

export function markBasicAuthenticated(request: FastifyRequest): void {
  basicAuthenticatedRequests.add(request);
}

export function isOwnerRequest(request: FastifyRequest): boolean {
  return basicAuthenticatedRequests.has(request) || isLoopbackRequest(request);
}
