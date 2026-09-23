// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { getRequestIdentity } from '../identity/request.js';

import type { FastifyRequest } from 'fastify';

/** Owner authority comes only from the installed identity service. */
export function isOwnerRequest(request: FastifyRequest): boolean {
  return getRequestIdentity(request)?.owner === true;
}
