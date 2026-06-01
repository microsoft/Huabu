/**
 * Origin header check for state-changing requests.
 *
 * Threat model: a third-party page the user has open (e.g. `evil.com`)
 * tries to trigger writes against the local Sediment server using the
 * user's ambient credentials. Modern browsers attach `Origin` to every
 * non-safe HTTP method (POST/PUT/PATCH/DELETE) and — crucially —
 * `Origin` is browser-controlled: JavaScript cannot lie about it. So
 * comparing it against an allowlist is a complete defence.
 *
 * We reuse {@link resolveAllowedHostnames} so a single env var
 * (`HUABU_ALLOWED_HOSTS`) drives Host guard, CORS, and Origin guard
 * consistently. Any scheme and any port on an allowed hostname is
 * accepted — that lets `http://localhost:5173` (Vite dev) and
 * `https://sediment.example` (reverse-proxied prod) both work without
 * extra configuration.
 *
 * Non-browser callers (curl, native apps, server-to-server scripts)
 * routinely omit `Origin`. For a local developer tool we treat missing
 * Origin as "not a browser" and let it through; the Host guard already
 * vouches for the target hostname and the caller cannot be CSRF'd.
 */

import { resolveAllowedHostnames } from './host-guard.js';

import type { FastifyPluginAsync } from 'fastify';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Pull the hostname out of an `Origin` value such as
 * `http://localhost:5173` or `https://[::1]:8080`. Returns `null` for
 * malformed input or the literal string `"null"` (which browsers send
 * for sandboxed iframes / file:// pages).
 */
function extractHostname(origin: string): string | null {
  if (origin === 'null') return null;
  try {
    const url = new URL(origin);
    // URL.hostname returns IPv6 literals without brackets; the allowlist
    // stores them with brackets to match the Host-header canonical form.
    return url.hostname.includes(':') ? `[${url.hostname}]` : url.hostname;
  } catch {
    return null;
  }
}

export const originGuardPlugin: FastifyPluginAsync = async (app) => {
  const allowed = resolveAllowedHostnames();
  app.addHook('onRequest', async (request, reply) => {
    if (SAFE_METHODS.has(request.method)) return;
    const origin = request.headers.origin;
    // Missing Origin → non-browser caller; cannot be tricked into CSRF.
    if (!origin) return;
    const hostname = extractHostname(origin);
    if (!hostname || !allowed.has(hostname.toLowerCase())) {
      return reply.status(403).send({
        message: 'Cross-origin write blocked',
        code: 'BAD_ORIGIN',
        details: {
          receivedOrigin: origin,
          hint: 'Add the hostname to HUABU_ALLOWED_HOSTS if this is an intentional deployment.',
        },
      });
    }
  });
  app.log.info('[security] Origin guard active for non-safe methods');
};
