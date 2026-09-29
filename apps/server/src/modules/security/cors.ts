// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { originHostname } from './host-guard.js';

import type { FastifyCorsOptions } from '@fastify/cors';

/**
 * CORS options for the Huabu HTTP server. Any scheme or port is accepted on
 * an allowed hostname, so `http://localhost:5173` (Vite dev) and
 * `https://huabu.example` (reverse proxy) both work without further
 * configuration.
 */
export function createCorsOptions(
  allowedHostnames: ReadonlySet<string>,
): FastifyCorsOptions {
  return {
    origin: (origin, cb) => {
      // Non-browser callers (curl, server-to-server, native apps) omit
      // Origin entirely — allow them; the Host guard already validates
      // their target hostname.
      if (!origin) return cb(null, true);
      const hostname = originHostname(origin);
      cb(null, hostname !== null && allowedHostnames.has(hostname));
    },
    // @fastify/cors v11 narrowed its default to the CORS-safelisted methods;
    // keep the v10 set, since the API uses PUT, PATCH, and DELETE.
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'],
    credentials: false,
  };
}
