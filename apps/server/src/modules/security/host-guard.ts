// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Host header allowlist.
 *
 * Browsers always populate `Host` with the hostname the user typed (or
 * that JavaScript supplied to `fetch`), regardless of what IP the DNS
 * resolved to. That makes the header the canonical defence against DNS
 * rebinding: even if an attacker resolves `evil.com` to 127.0.0.1, the
 * browser still writes `Host: evil.com`, which we can reject.
 *
 * Built-in entries cover the loopback aliases the bundled web client
 * uses out of the box. Operators add LAN IPs or reverse-proxy hostnames
 * via `HUABU_ALLOWED_HOSTS`.
 */

import fp from 'fastify-plugin';

/** Hostnames always accepted, even when `HUABU_ALLOWED_HOSTS` is empty. */
const BUILTIN_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'] as const;

/**
 * Extract the hostname portion of an HTTP `Host` header.
 *
 * `Host` may include a port (`localhost:3001`) and IPv6 literals are
 * bracketed (`[::1]:3001`). We normalise both shapes to a comparable
 * lowercase hostname.
 */
function extractHostname(host: string | undefined): string | null {
  if (!host) return null;
  const lower = host.toLowerCase();
  if (lower.startsWith('[')) {
    const end = lower.indexOf(']');
    return end === -1 ? null : lower.slice(0, end + 1);
  }
  const colon = lower.indexOf(':');
  return colon === -1 ? lower : lower.slice(0, colon);
}

/**
 * Extract the allowlist-comparable hostname from an `Origin` value such as
 * `http://localhost:5173` or `https://[::1]:8080`. `URL.hostname` already
 * lowercases and keeps IPv6 literals bracketed, matching the canonical form
 * of the allowlist. Returns `null` for malformed input and for the literal
 * `"null"` that browsers send from sandboxed iframes and `file://` pages.
 */
export function originHostname(origin: string): string | null {
  if (origin === 'null') return null;
  try {
    return new URL(origin).hostname || null;
  } catch {
    return null;
  }
}

/**
 * Read the merged allowlist (builtins + env extras).
 *
 * Exported so the CORS layer can reuse the same set of hostnames.
 */
export function resolveAllowedHostnames(): Set<string> {
  const extra = (process.env.HUABU_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set<string>([...BUILTIN_HOSTNAMES, ...extra]);
}

// Wrapped with fastify-plugin so the hook applies to every route on the
// instance that registers it, not only inside this plugin's own scope.
export const hostGuardPlugin = fp(
  async (app) => {
    const allowed = resolveAllowedHostnames();
    app.addHook('onRequest', async (request, reply) => {
      // CORS preflight must always pass — the actual request is checked.
      if (request.method === 'OPTIONS') return;
      const hostname = extractHostname(request.headers.host);
      if (!hostname || !allowed.has(hostname)) {
        return reply.status(403).send({
          message: 'Invalid Host header',
          code: 'INVALID_HOST',
          details: {
            received: hostname ?? null,
            hint: 'Add the hostname to HUABU_ALLOWED_HOSTS if this is an intentional deployment.',
          },
        });
      }
    });
    app.log.info(
      `[security] Host allowlist active: [${[...allowed].join(', ')}]`,
    );
  },
  { name: 'huabu-host-guard', fastify: '5.x' },
);
