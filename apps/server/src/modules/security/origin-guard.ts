// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Cross-origin write guard for state-changing requests.
 *
 * Threat model: a third-party page the user has open (e.g. `evil.com`)
 * tries to trigger writes against the local Huabu server using the
 * user's ambient credentials.
 *
 * Defence is layered, from strongest to weakest:
 *
 *   1. **Fetch Metadata (`Sec-Fetch-Site`)** — W3C / WHATWG-standard,
 *      shipped in all evergreen browsers since 2020. The header is on
 *      the "forbidden" list, so page JavaScript cannot set or remove
 *      it. We accept only `same-origin`, `same-site`, and `none`
 *      (direct navigation, refresh); `cross-site` is rejected
 *      outright. This is the OWASP-recommended primary CSRF defence.
 *   2. **`Origin` allowlist** — fallback for older browsers / WebViews
 *      that don't emit `Sec-Fetch-*`. `Origin` is also browser-set and
 *      not forgeable by JS, but lacks the explicit cross-site signal.
 *      We reuse {@link resolveAllowedHostnames} so a single env var
 *      (`HUABU_ALLOWED_HOSTS`) drives Host guard, CORS, and this
 *      check.
 *   3. **Loopback peer fallback** — non-browser callers (curl, native
 *      apps, CI scripts) routinely emit neither header. For a local
 *      developer tool we allow them *only* when the TCP peer is a
 *      loopback address. We deliberately read
 *      `request.socket.remoteAddress` (the real TCP peer) instead of
 *      `request.ip`, because `request.ip` becomes attacker-controllable
 *      via `X-Forwarded-For` if Fastify's `trustProxy` is ever
 *      enabled. Non-loopback callers without any origin signal are
 *      rejected; they should pin themselves to the deployment by
 *      adding the proper `Origin` header.
 */

import fp from 'fastify-plugin';

import { originHostname, resolveAllowedHostnames } from './host-guard.js';
import { isLoopbackRequest } from './peer.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Fetch Metadata values that are safe for state-changing requests.
 * `cross-site` is the only value we reject; everything else means
 * either a same-origin call (Huabu's own UI), a same-registrable-
 * domain call (Vite dev server → API on a different port), or a
 * top-level user action (`none`: bookmark, refresh, address-bar).
 */
const SAFE_FETCH_SITES = new Set(['same-origin', 'same-site', 'none']);

// Wrapped with fastify-plugin so the hook applies to every route on the
// instance that registers it, not only inside this plugin's own scope.
export const originGuardPlugin = fp(
  async (app) => {
    const allowed = resolveAllowedHostnames();
    app.addHook('onRequest', async (request, reply) => {
      if (SAFE_METHODS.has(request.method)) return;

      // ─ Layer 1: Fetch Metadata (preferred, JS-unforgeable). ─────────
      const site = request.headers['sec-fetch-site'];
      if (typeof site === 'string') {
        if (SAFE_FETCH_SITES.has(site)) return;
        return reply.status(403).send({
          message: 'Cross-site write blocked',
          code: 'CROSS_SITE_BLOCKED',
          details: {
            secFetchSite: site,
            hint: 'Open the app from one of the allowed origins (HUABU_ALLOWED_HOSTS) or use a trusted client.',
          },
        });
      }

      // ─ Layer 2: Origin allowlist (older browsers, WebViews). ────────
      const origin = request.headers.origin;
      if (typeof origin === 'string') {
        const hostname = originHostname(origin);
        if (hostname && allowed.has(hostname)) return;
        return reply.status(403).send({
          message: 'Cross-origin write blocked',
          code: 'BAD_ORIGIN',
          details: {
            receivedOrigin: origin,
            hint: 'Add the hostname to HUABU_ALLOWED_HOSTS if this is an intentional deployment.',
          },
        });
      }

      // ─ Layer 3: Non-browser caller — must be loopback. ──────────────
      if (isLoopbackRequest(request)) return;

      return reply.status(403).send({
        message:
          'Write rejected: no Sec-Fetch-Site or Origin header and request did not originate from loopback.',
        code: 'NO_ORIGIN_NON_LOCAL',
        details: {
          hint: 'Browser callers must send Origin; non-browser callers must connect via 127.0.0.1 or [::1].',
        },
      });
    });
    app.log.info(
      '[security] Cross-origin write guard active (Sec-Fetch-Site → Origin → loopback fallback)',
    );
  },
  { name: 'huabu-origin-guard', fastify: '5.x' },
);
