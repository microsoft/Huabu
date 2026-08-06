// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Loopback peer check.
 *
 * Reads `socket.remoteAddress` (the real TCP peer) instead of
 * `request.ip` so the result cannot be spoofed via `X-Forwarded-For`
 * if Fastify's `trustProxy` is ever enabled.
 */

import type { FastifyRequest } from 'fastify';

export function isLoopbackRequest(request: FastifyRequest): boolean {
  const peer = request.socket.remoteAddress ?? '';
  return peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
}
