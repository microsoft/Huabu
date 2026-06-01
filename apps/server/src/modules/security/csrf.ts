/**
 * CSRF protection via a per-install random token.
 *
 * Threat model: a third-party page the user has open (e.g. `evil.com`)
 * tries to trigger state-changing requests against the local Sediment
 * server using the user's ambient credentials. Same-Origin Policy lets
 * the attacker SEND such requests (forms, `fetch`), but it cannot READ
 * the response unless our CORS layer explicitly allows the origin.
 *
 * We exploit that asymmetry: at app boot the web client fetches
 * `GET /api/security/bootstrap` (same-origin only — CORS is locked
 * down in `app.ts`) and stores the returned `csrfToken` in memory.
 * Every non-safe HTTP method (POST/PUT/PATCH/DELETE) must echo the
 * token in the `X-Sediment-CSRF` header; mismatches return 403.
 *
 * The token is generated once and persisted to `data/security-token`
 * so it survives restarts — otherwise the live web UI would 403 every
 * time the operator restarts the backend.
 */

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { CSRF_HEADER, CSRF_INVALID_CODE } from '@sediment/shared';

import type { FastifyPluginAsync } from 'fastify';

/** Path the bootstrap endpoint is mounted on. */
export const CSRF_BOOTSTRAP_PATH = '/api/security/bootstrap';

/**
 * URL prefixes that bypass the CSRF check.
 *
 *  - The bootstrap endpoint must answer without a token (it's the
 *    chicken-and-egg base case).
 *  - The agentlet ACP bridge is a WebSocket upgrade attached to the
 *    raw HTTP server (not Fastify's route chain) and carries its own
 *    `ACP_DEV_TOKEN`-based auth in `bridge/hello`. See
 *    `modules/agent/acp/server-mount.ts`.
 */
export const CSRF_EXEMPT_PREFIXES = [
  CSRF_BOOTSTRAP_PATH,
  '/api/acp/agent',
] as const;

const TOKEN_BYTES = 32;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function tokenStorePath(): string {
  return join(process.cwd(), 'data', 'security-token');
}

/**
 * Read the persisted CSRF token, generating + persisting a fresh one
 * on first boot (or when the on-disk file is unreadable/empty).
 *
 * The file is `chmod 0600` so other local users cannot read it. We
 * deliberately do *not* fall back to env vars: an operator who wants
 * deterministic tokens should manage the file directly.
 */
function loadOrCreateToken(): string {
  const path = tokenStorePath();
  if (existsSync(path)) {
    try {
      const persisted = readFileSync(path, 'utf-8').trim();
      if (persisted.length >= 32) return persisted;
    } catch {
      /* fall through and regenerate */
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  const token = randomBytes(TOKEN_BYTES).toString('hex');
  writeFileSync(path, token, 'utf-8');
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort on platforms without POSIX perms */
  }
  return token;
}

export const csrfPlugin: FastifyPluginAsync = async (app) => {
  const token = loadOrCreateToken();
  const headerKey = CSRF_HEADER.toLowerCase();

  app.get(CSRF_BOOTSTRAP_PATH, async () => ({ csrfToken: token }));

  app.addHook('onRequest', async (request, reply) => {
    if (SAFE_METHODS.has(request.method)) return;
    if (CSRF_EXEMPT_PREFIXES.some((p) => request.url.startsWith(p))) return;
    const received = request.headers[headerKey];
    if (typeof received === 'string' && received === token) return;
    return reply.status(403).send({
      message: 'Missing or invalid CSRF token',
      code: CSRF_INVALID_CODE,
    });
  });

  app.log.info(
    `[security] CSRF protection active; bootstrap at ${CSRF_BOOTSTRAP_PATH}`,
  );
};
