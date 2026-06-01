/**
 * Network security primitives for the Sediment HTTP server.
 *
 * Two layered defences against drive-by attacks when the server is
 * reachable from outside `localhost`:
 *
 *   1. `hostGuardPlugin` — rejects requests whose `Host` header is not
 *      in the allowlist. Defends against DNS rebinding (attacker DNS
 *      pointing `evil.com` → 127.0.0.1; browser still sends
 *      `Host: evil.com` so the server can detect and block it).
 *   2. `originGuardPlugin` — rejects non-safe HTTP methods
 *      (POST/PUT/PATCH/DELETE) whose `Origin` header is not in the
 *      allowlist. Defends against cross-origin writes from third-party
 *      pages the user happens to have open; `Origin` is
 *      browser-controlled so attacker JavaScript cannot lie about it.
 *
 * Both default to the loopback-only profile and opt into broader hosts
 * via the `HUABU_ALLOWED_HOSTS` environment variable (comma-separated
 * hostnames, no port; e.g. `192.168.1.50,sediment.team-a.example`).
 *
 * The CORS allowlist is derived from the same set — see `app.ts`.
 */

export { hostGuardPlugin, resolveAllowedHostnames } from './host-guard.js';
export { originGuardPlugin } from './origin-guard.js';
