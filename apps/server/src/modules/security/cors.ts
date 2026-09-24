// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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
      try {
        const parsed = new URL(origin);
        // URL.hostname strips the port and lowercases; IPv6 literals
        // come back without the brackets, so re-add them to match the
        // allowlist's canonical form.
        const hostname = parsed.hostname.includes(':')
          ? `[${parsed.hostname}]`
          : parsed.hostname;
        cb(null, allowedHostnames.has(hostname));
      } catch {
        cb(null, false);
      }
    },
    // @fastify/cors v11 narrowed its default to the CORS-safelisted methods;
    // keep the v10 set, since the API uses PUT, PATCH, and DELETE.
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'],
    credentials: false,
  };
}
